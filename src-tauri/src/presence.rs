//! LAN presence — Phase 1 of clawd's social mode.
//!
//! Cats from other clawd instances on the same local network wander onto your
//! screen. Discovery is pure peer-to-peer over **mDNS** (no server); live state
//! is exchanged as small **UDP JSON heartbeats** carrying only *coarse* signals
//! — a nickname, coat color, cat mood, and an activity bucket. Raw token
//! counts, cost, and project names never leave the machine.
//!
//! The wire + delivery mechanism sits behind the [`Transport`] trait so a future
//! WAN transport (e.g. iroh: hole-punch to direct P2P, public relay as
//! fallback) can slot in without touching the peer table, the emit-to-frontend
//! loop, or the frontend at all. [`LanTransport`] is today's only impl.
//!
//! Everything here is opt-in: nothing binds a socket or advertises a service
//! until the frontend calls [`presence_start`], which it only does when the
//! user has flipped the network toggle on.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// mDNS service type clawd instances advertise + browse for.
const SERVICE_TYPE: &str = "_clawd-presence._udp.local.";
/// How often we fan our own payload out to known peers.
const PUBLISH_INTERVAL: Duration = Duration::from_secs(5);
/// UDP/browse blocking read timeout — bounds how fast the worker threads notice
/// a `stop()`.
const RECV_TIMEOUT: Duration = Duration::from_secs(2);
/// A peer we haven't heard from in this long is considered offline and dropped.
/// Comfortably above [`PUBLISH_INTERVAL`] so a single dropped heartbeat doesn't
/// blink a cat out.
const PEER_STALE: Duration = Duration::from_secs(15);
/// Prune cadence for the stale-peer sweep.
const PRUNE_INTERVAL: Duration = Duration::from_secs(3);

/// The coarse, privacy-safe snapshot a clawd shares with its peers. This is the
/// *entire* wire format — deliberately just enough to render someone's cat and
/// a rough "how busy are they" vibe. Built by the frontend (see
/// `hooks/usePresence.ts`) so identity + labeling stay in one place.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PresencePayload {
    /// Stable per-install id (generated + persisted by the frontend). Keys the
    /// peer table and lets us ignore our own advertisement.
    pub id: String,
    /// Display name shown under the peer's cat.
    pub nickname: String,
    /// Coat color id (`cream` / `black` / …) so the peer cat looks like theirs.
    pub color: String,
    /// Cat mood (`sleeping` / `playing` / … / `exhausted`) → drives the pose.
    pub state: String,
    /// Coarse activity bucket (`idle` / `light` / `busy` / `intense`). Carries
    /// no exact numbers — just enough for a vibe badge.
    pub activity: String,
}

/// A discovery + delivery mechanism for presence payloads. LAN today; a WAN
/// (iroh) transport can implement the same trait later without the engine or
/// frontend noticing.
pub trait Transport: Send {
    /// Begin discovering peers and receiving their payloads. Received payloads
    /// are handed to `on_recv` from a background thread the transport owns.
    /// Cheap to call after the local payload has been seeded via [`set_local`].
    fn start(
        &mut self,
        on_recv: Box<dyn Fn(PresencePayload) + Send + 'static>,
    ) -> Result<(), String>;
    /// Update the payload the transport periodically broadcasts. Safe to call
    /// before `start` (it's the seed) or repeatedly after (a live update).
    fn set_local(&self, payload: PresencePayload);
    /// Leave the network and release every socket / thread / daemon.
    fn stop(&mut self);
}

/// LAN transport: mDNS for discovery, UDP JSON datagrams for live state.
pub struct LanTransport {
    local: Arc<Mutex<Option<PresencePayload>>>,
    /// fullname → peer's UDP socket address, filled by the discovery thread.
    peers: Arc<Mutex<HashMap<String, SocketAddr>>>,
    running: Arc<AtomicBool>,
    daemon: Option<ServiceDaemon>,
    threads: Vec<JoinHandle<()>>,
    fullname: Option<String>,
}

impl LanTransport {
    pub fn new() -> Self {
        Self {
            local: Arc::new(Mutex::new(None)),
            peers: Arc::new(Mutex::new(HashMap::new())),
            running: Arc::new(AtomicBool::new(false)),
            daemon: None,
            threads: Vec::new(),
            fullname: None,
        }
    }
}

impl Default for LanTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl Transport for LanTransport {
    fn start(
        &mut self,
        on_recv: Box<dyn Fn(PresencePayload) + Send + 'static>,
    ) -> Result<(), String> {
        if self.running.load(Ordering::SeqCst) {
            return Ok(());
        }

        // Our UDP heartbeat socket. Ephemeral port; we advertise it over mDNS so
        // peers know where to send. The read timeout lets the recv loop notice a
        // `stop()` promptly.
        let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
        socket
            .set_read_timeout(Some(RECV_TIMEOUT))
            .map_err(|e| e.to_string())?;
        let port = socket.local_addr().map_err(|e| e.to_string())?.port();
        let socket = Arc::new(socket);

        let id = {
            let g = self.local.lock().unwrap();
            g.as_ref().map(|p| p.id.clone()).unwrap_or_default()
        };

        // Advertise ourselves. `enable_addr_auto` fills in this host's LAN
        // addresses so peers can resolve one; the `id` TXT lets peers (and we)
        // skip our own advertisement.
        let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
        let instance = format!("clawd-{id}");
        let host = format!("{instance}.local.");
        let props: &[(&str, &str)] = &[("id", id.as_str())];
        let info = ServiceInfo::new(SERVICE_TYPE, &instance, &host, (), port, props)
            .map_err(|e| e.to_string())?
            .enable_addr_auto();
        self.fullname = Some(info.get_fullname().to_string());
        daemon.register(info).map_err(|e| e.to_string())?;

        let browse = daemon.browse(SERVICE_TYPE).map_err(|e| e.to_string())?;

        self.running.store(true, Ordering::SeqCst);
        self.daemon = Some(daemon);

        // Discovery: resolve peers → (ipv4, advertised udp port), keyed by
        // fullname so a `ServiceRemoved` can drop them again.
        let peers = self.peers.clone();
        let running = self.running.clone();
        let my_id = id.clone();
        self.threads.push(std::thread::spawn(move || {
            while running.load(Ordering::SeqCst) {
                match browse.recv_timeout(RECV_TIMEOUT) {
                    Ok(ServiceEvent::ServiceResolved(info)) => {
                        if info.get_property_val_str("id") == Some(my_id.as_str()) {
                            continue; // that's us
                        }
                        let addr = info.get_addresses().iter().find_map(|ip| match ip {
                            IpAddr::V4(v4) => {
                                Some(SocketAddr::new(IpAddr::V4(*v4), info.get_port()))
                            }
                            _ => None,
                        });
                        if let Some(addr) = addr {
                            peers
                                .lock()
                                .unwrap()
                                .insert(info.get_fullname().to_string(), addr);
                        }
                    }
                    Ok(ServiceEvent::ServiceRemoved(_ty, fullname)) => {
                        peers.lock().unwrap().remove(&fullname);
                    }
                    Ok(_) => {}
                    Err(_) => {} // timeout — loop and re-check `running`
                }
            }
        }));

        // Receive: parse incoming JSON datagrams into payloads and hand up.
        let recv_sock = socket.clone();
        let running_r = self.running.clone();
        self.threads.push(std::thread::spawn(move || {
            let mut buf = [0u8; 2048];
            while running_r.load(Ordering::SeqCst) {
                if let Ok((n, _from)) = recv_sock.recv_from(&mut buf) {
                    if let Ok(payload) = serde_json::from_slice::<PresencePayload>(&buf[..n]) {
                        on_recv(payload);
                    }
                }
            }
        }));

        // Publish: fan our latest payload out to every known peer on a cadence.
        let pub_sock = socket;
        let running_p = self.running.clone();
        let local = self.local.clone();
        let peers_p = self.peers.clone();
        self.threads.push(std::thread::spawn(move || {
            while running_p.load(Ordering::SeqCst) {
                let payload = local.lock().unwrap().clone();
                if let Some(payload) = payload {
                    if let Ok(bytes) = serde_json::to_vec(&payload) {
                        let targets: Vec<SocketAddr> =
                            peers_p.lock().unwrap().values().copied().collect();
                        for addr in targets {
                            let _ = pub_sock.send_to(&bytes, addr);
                        }
                    }
                }
                std::thread::sleep(PUBLISH_INTERVAL);
            }
        }));

        Ok(())
    }

    fn set_local(&self, payload: PresencePayload) {
        *self.local.lock().unwrap() = Some(payload);
    }

    fn stop(&mut self) {
        if !self.running.swap(false, Ordering::SeqCst) {
            return;
        }
        if let (Some(daemon), Some(fullname)) = (&self.daemon, &self.fullname) {
            let _ = daemon.unregister(fullname);
            let _ = daemon.shutdown();
        }
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
        self.daemon = None;
        self.fullname = None;
        self.peers.lock().unwrap().clear();
    }
}

// ---------------------------------------------------------------------------
// Engine — owns the transport + the live peer table, and pushes `peers`
// snapshots to the frontend. Managed as Tauri state.
// ---------------------------------------------------------------------------

struct PeerEntry {
    payload: PresencePayload,
    last_seen: Instant,
}

/// Managed state binding the transport to the frontend. Off (no sockets, no
/// threads) until [`presence_start`].
pub struct Presence {
    transport: Mutex<LanTransport>,
    peers: Arc<Mutex<HashMap<String, PeerEntry>>>,
    running: Arc<AtomicBool>,
    prune: Mutex<Option<JoinHandle<()>>>,
}

impl Default for Presence {
    fn default() -> Self {
        Self {
            transport: Mutex::new(LanTransport::new()),
            peers: Arc::new(Mutex::new(HashMap::new())),
            running: Arc::new(AtomicBool::new(false)),
            prune: Mutex::new(None),
        }
    }
}

impl Presence {
    fn start(&self, app: &AppHandle, payload: PresencePayload) -> Result<(), String> {
        // Seed the outgoing payload first so the very first heartbeat is real.
        {
            let t = self.transport.lock().unwrap();
            t.set_local(payload);
        }

        if self.running.load(Ordering::SeqCst) {
            return Ok(()); // already up — the seed above is the live update
        }

        // On each received payload: upsert the peer table and push a fresh
        // snapshot to the frontend.
        let peers = self.peers.clone();
        let app_recv = app.clone();
        let on_recv = Box::new(move |p: PresencePayload| {
            {
                let mut table = peers.lock().unwrap();
                table.insert(
                    p.id.clone(),
                    PeerEntry {
                        payload: p,
                        last_seen: Instant::now(),
                    },
                );
            }
            emit_peers(&app_recv, &peers);
        });

        self.transport.lock().unwrap().start(on_recv)?;
        self.running.store(true, Ordering::SeqCst);

        // Stale sweep: drop peers we've stopped hearing from and re-emit.
        let peers_prune = self.peers.clone();
        let running = self.running.clone();
        let app_prune = app.clone();
        *self.prune.lock().unwrap() = Some(std::thread::spawn(move || {
            while running.load(Ordering::SeqCst) {
                std::thread::sleep(PRUNE_INTERVAL);
                let removed = {
                    let mut table = peers_prune.lock().unwrap();
                    let before = table.len();
                    table.retain(|_, e| e.last_seen.elapsed() < PEER_STALE);
                    before != table.len()
                };
                if removed {
                    emit_peers(&app_prune, &peers_prune);
                }
            }
        }));

        Ok(())
    }

    fn publish(&self, payload: PresencePayload) {
        if self.running.load(Ordering::SeqCst) {
            self.transport.lock().unwrap().set_local(payload);
        }
    }

    /// Current live peers, for a window that mounts after discovery has already
    /// happened (events aren't retained, so a late listener needs a snapshot).
    fn peers_snapshot(&self) -> Vec<PresencePayload> {
        self.peers
            .lock()
            .unwrap()
            .values()
            .map(|e| e.payload.clone())
            .collect()
    }

    fn stop(&self, app: &AppHandle) {
        if !self.running.swap(false, Ordering::SeqCst) {
            return;
        }
        self.transport.lock().unwrap().stop();
        if let Some(h) = self.prune.lock().unwrap().take() {
            let _ = h.join();
        }
        self.peers.lock().unwrap().clear();
        let _ = app.emit("peers", Vec::<PresencePayload>::new());
    }
}

/// Push the current live peer list to the frontend as a `peers` event.
fn emit_peers(app: &AppHandle, peers: &Arc<Mutex<HashMap<String, PeerEntry>>>) {
    let list: Vec<PresencePayload> = peers
        .lock()
        .unwrap()
        .values()
        .map(|e| e.payload.clone())
        .collect();
    let _ = app.emit("peers", list);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Turn presence on (opt-in) and seed our payload. Idempotent — calling again
/// while running just updates the payload.
#[tauri::command]
pub fn presence_start(
    app: AppHandle,
    state: tauri::State<'_, Presence>,
    payload: PresencePayload,
) -> Result<(), String> {
    state.start(&app, payload)
}

/// Update the coarse payload we broadcast (mood/color/nickname changed). No-op
/// while presence is off.
#[tauri::command]
pub fn presence_publish(state: tauri::State<'_, Presence>, payload: PresencePayload) {
    state.publish(payload);
}

/// Leave the network: stop advertising, drop peers, clear the frontend.
#[tauri::command]
pub fn presence_stop(app: AppHandle, state: tauri::State<'_, Presence>) {
    state.stop(&app);
}

/// Snapshot of the peers currently online, for an instant paint on mount.
#[tauri::command]
pub fn presence_peers(state: tauri::State<'_, Presence>) -> Vec<PresencePayload> {
    state.peers_snapshot()
}
