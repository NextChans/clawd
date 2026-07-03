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
use std::fmt;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_lite::StreamExt;
use iroh::{Endpoint, NodeAddr, RelayMap, RelayMode, RelayUrl, SecretKey, Watcher};
use iroh_gossip::{
    api::Event,
    net::{Gossip, GOSSIP_ALPN},
    proto::TopicId,
};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Callback the transports hand received peer payloads to.
type OnRecv = Arc<dyn Fn(PresencePayload) + Send + Sync>;

/// mDNS service type clawd instances advertise + browse for.
const SERVICE_TYPE: &str = "_clawd-presence._udp.local.";
/// How often we fan our own payload out to known peers.
const PUBLISH_INTERVAL: Duration = Duration::from_secs(5);
/// UDP/browse blocking read timeout — bounds how fast the worker threads notice
/// a `stop()`.
const RECV_TIMEOUT: Duration = Duration::from_secs(2);
/// A peer we haven't heard from in this long is considered offline and dropped.
/// Comfortably above the heartbeat interval so several dropped/late beats don't
/// blink a cat out — gossip over a relay can jitter, so this is generous.
const PEER_STALE: Duration = Duration::from_secs(30);
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

/// A discovery + delivery mechanism for presence payloads. LAN (mDNS) and WAN
/// (iroh rooms) both feed the same engine through this shape.
pub trait Transport: Send {
    /// Begin discovering peers and receiving their payloads. Received payloads
    /// are handed to `on_recv` from a background thread the transport owns.
    /// Cheap to call after the local payload has been seeded via [`set_local`].
    fn start(&mut self, on_recv: OnRecv) -> Result<(), String>;
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
    fn start(&mut self, on_recv: OnRecv) -> Result<(), String> {
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
// WAN transport — iroh gossip "rooms" for remote friends. QUIC hole-punching
// with n0's public relays as fallback (no server of our own). Same coarse
// payload, carried over a gossip topic. Async, so it runs on its own tokio
// runtime thread.
// ---------------------------------------------------------------------------

/// How often the iroh transport rebroadcasts our payload into the room.
const IROH_PUBLISH_INTERVAL: Duration = Duration::from_secs(5);
/// If a joiner hasn't heard from the room for this long (even while gossip still
/// reports a neighbor — a stalled direct link with no relay fallback), re-
/// subscribe to re-dial the bootstrap peer and refresh the connection before
/// the peer goes stale. Comfortably above the 5s heartbeat so normal jitter
/// doesn't trigger it.
const IROH_REDIAL_AFTER: Duration = Duration::from_secs(12);

/// A room invite: the gossip topic plus bootstrap peer addresses. Serialized to
/// a base32 "room code" the user shares. Mirrors the iroh-gossip chat example.
#[derive(Debug, Serialize, Deserialize)]
struct RoomTicket {
    topic: TopicId,
    peers: Vec<NodeAddr>,
}

impl RoomTicket {
    fn from_bytes(bytes: &[u8]) -> anyhow::Result<Self> {
        Ok(postcard::from_bytes(bytes)?)
    }
    fn to_bytes(&self) -> Vec<u8> {
        postcard::to_stdvec(self).expect("postcard::to_stdvec is infallible")
    }
}

impl fmt::Display for RoomTicket {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        let mut text = data_encoding::BASE32_NOPAD.encode(&self.to_bytes());
        text.make_ascii_lowercase();
        write!(f, "{text}")
    }
}

impl FromStr for RoomTicket {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let bytes = data_encoding::BASE32_NOPAD.decode(s.to_ascii_uppercase().as_bytes())?;
        Self::from_bytes(&bytes)
    }
}

/// Called with the base32 room code once our endpoint is up (so the UI can show
/// it to share).
type OnRoom = Arc<dyn Fn(String) + Send + Sync>;

/// Called with `(joined, neighbor_count)` so the UI can show whether we've
/// connected and to how many peers — the key signal for diagnosing a remote
/// room that isn't linking up across networks.
type OnStatus = Arc<dyn Fn(bool, usize) + Send + Sync>;

/// Called with a short human-readable diagnostic string (e.g. the assigned
/// relay) so a stuck room can be debugged from the UI.
type OnDebug = Arc<dyn Fn(String) + Send + Sync>;

/// n0's public relays, addressed by their **current** hostnames.
///
/// We can't use iroh 0.91.2's built-in `RelayMode::Default`: its baked-in relay
/// URLs still point at the old `*.relay.n0.iroh.iroh.link` names (note the
/// doubled `iroh`), but n0 has since moved the relays to `*.relay.n0.iroh.link`
/// and the TLS cert only covers the new names. So the default relays fail
/// hostname verification, the endpoint never gets a home relay, and
/// cross-network rooms sit stuck on 🟡 "릴레이 없음" forever (LAN rooms are fine
/// — they don't need a relay). Verified in the field: `openssl s_client` to the
/// doubled name returns a cert for the single-`iroh` name. Shipping the
/// corrected map ourselves fixes it without waiting on an iroh bump.
fn n0_relay_map() -> RelayMap {
    [
        "https://use1-1.relay.n0.iroh.link", // North America
        "https://euc1-1.relay.n0.iroh.link", // Europe
        "https://aps1-1.relay.n0.iroh.link", // Asia-Pacific
    ]
    .into_iter()
    .filter_map(|s| s.parse::<RelayUrl>().ok())
    .collect()
}

/// Build the relay configuration for the endpoint. A user-supplied **custom
/// relay** (e.g. a self-hosted `iroh-relay`) takes over when set and parseable,
/// otherwise we use n0's public relays ({@link n0_relay_map}).
///
/// A custom relay *replaces* the defaults rather than adding to them: a
/// self-hosted relay doesn't mesh with n0's, so for two peers to route through
/// it, it has to be the home relay on *both* sides — which only happens
/// reliably if it's the only one configured. Hence both peers must set the
/// **same** URL. The payoff is bypassing a network that blocks n0's public
/// relay hostnames (the "🟡 릴레이 없음" case): point both at your own relay on
/// plain `:443` and it looks like ordinary HTTPS.
fn relay_mode_from(relay_url: Option<&str>) -> RelayMode {
    match relay_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse::<RelayUrl>().ok())
    {
        Some(url) => RelayMode::Custom(RelayMap::from(url)),
        None => RelayMode::Custom(n0_relay_map()),
    }
}

/// The async heart of the iroh transport: build endpoint + gossip, join/open
/// the room, then broadcast our latest payload on a cadence while handing
/// received payloads to `on_recv`, until `running` clears.
#[allow(clippy::too_many_arguments)]
async fn run_room(
    secret: SecretKey,
    room: Option<RoomTicket>,
    relay_url: Option<String>,
    local: Arc<Mutex<Option<PresencePayload>>>,
    running: Arc<AtomicBool>,
    on_recv: OnRecv,
    on_room: OnRoom,
    on_status: OnStatus,
    on_debug: OnDebug,
) -> anyhow::Result<()> {
    // Normalize once: an empty/whitespace URL means "no custom relay".
    let custom_relay = relay_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    // `discovery_n0` publishes our NodeId → address (incl. relay) to n0's DNS
    // and resolves peers the same way, so a joiner can reach the host across
    // different networks even if the shared ticket's addresses are LAN-only.
    // Without it, cross-network rooms only linked up on the same LAN. (Discovery
    // is independent of the relay, so it still works under a custom relay.)
    let endpoint = Endpoint::builder()
        .secret_key(secret)
        .relay_mode(relay_mode_from(custom_relay.as_deref()))
        .discovery_n0()
        .bind()
        .await?;
    let gossip = Gossip::builder().spawn(endpoint.clone());
    let router = iroh::protocol::Router::builder(endpoint.clone())
        .accept(GOSSIP_ALPN, gossip.clone())
        .spawn();

    let (topic, bootstrap): (TopicId, Vec<NodeAddr>) = match room {
        Some(t) => (t.topic, t.peers),
        None => (TopicId::from_bytes(rand::random()), vec![]),
    };

    // Wait for a home relay before minting the code, so it carries a relay URL —
    // without it the node addr is LAN-only and a joiner on another network has
    // no path to us (rooms that link on the same Wi-Fi but stay stuck 🟡 across
    // networks). `home_relay().initialized()` can resolve on an *empty* value,
    // so instead poll for a non-empty relay set (up to ~15s). Bounded so a
    // relay-blocked network doesn't hang room creation.
    let mut relay_str = String::new();
    for _ in 0..30 {
        let relays = endpoint.home_relay().get();
        if !relays.is_empty() {
            relay_str = relays
                .iter()
                .map(|u| u.to_string())
                .collect::<Vec<_>>()
                .join(", ");
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    // Surface the relay we got — the decisive clue when a room won't link up
    // across networks (no relay ⇒ that network is blocking it).
    if relay_str.is_empty() {
        if custom_relay.is_some() {
            on_debug("커스텀 릴레이에 못 붙음 — URL·서버 상태를 확인하세요".to_string());
        } else {
            on_debug(
                "릴레이 없음 — 이 네트워크가 공용 릴레이를 막는 듯. 상세 설정에서 \
                 커스텀 릴레이를 넣거나 다른 네트워크(핫스팟)로 시도하세요"
                    .to_string(),
            );
        }
    } else if custom_relay.is_some() {
        on_debug(format!("커스텀 릴레이 {relay_str}"));
    } else {
        on_debug(format!("릴레이 {relay_str}"));
    }

    // Publish a shareable code that includes our own address, so joiners can
    // bootstrap off us even if the original host is gone.
    let me = endpoint.node_addr().initialized().await;
    let mut peers = bootstrap.clone();
    if !peers.iter().any(|p| p.node_id == me.node_id) {
        peers.push(me);
    }
    on_room(RoomTicket { topic, peers }.to_string());

    for peer in &bootstrap {
        let _ = endpoint.add_node_addr(peer.clone());
    }
    // NodeIds we can (re-)dial to heal the room: the ticket's bootstrap peers
    // plus every neighbor we later meet. The opener starts empty, so it used to
    // be unable to re-dial a stalled link — only the joiner (which had the
    // opener as bootstrap) could heal its side. That one-sidedness is the
    // "joiner's cat vanishes on the host after ~10s while the host's cat stays
    // fine on the joiner" bug: data flows opener→joiner, the joiner keeps
    // receiving so it never re-dials, the reverse link stalls, and the opener
    // had no one to re-dial. Remembering met neighbors lets *either* side
    // re-dial (discovery_n0 resolves the NodeId → address).
    let mut dial_ids: Vec<_> = bootstrap.iter().map(|p| p.node_id).collect();

    // Reconnect loop. We use `subscribe` (not `subscribe_and_join`) so we're
    // "in the room" immediately (🟡), broadcast right away, and flip to 🟢 as
    // NeighborUp events arrive. If the gossip stream ends — a relay/link hiccup
    // — we re-subscribe instead of tearing the room down for good; otherwise a
    // transient drop stops our heartbeats and the peer's cat goes stale and
    // vanishes ("appeared then disappeared").
    'outer: while running.load(Ordering::SeqCst) {
        on_status(false, 0);
        let sub = match gossip.subscribe(topic, dial_ids.clone()).await {
            Ok(s) => s,
            Err(_) => {
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        };
        let (sender, mut receiver) = sub.split();
        let mut neighbors: usize = 0;
        on_status(true, neighbors);

        // Re-dial off *message freshness*, not the neighbor count: with no relay
        // fallback a direct link can go silent while gossip still reports the
        // neighbor up, so watching for received data catches the "🟢 but the cat
        // vanished" case the neighbor count misses. Either side can re-dial once
        // it knows a peer to dial — checked live (against `dial_ids`) so it
        // activates the moment the opener first meets the joiner, not one
        // re-subscribe later.
        let mut last_activity = Instant::now();

        let mut ticker = tokio::time::interval(IROH_PUBLISH_INTERVAL);
        loop {
            if !running.load(Ordering::SeqCst) {
                break 'outer;
            }
            // Heard nothing for too long → re-subscribe, which re-dials the
            // known peers and refreshes the connection before we go stale.
            if !dial_ids.is_empty() && last_activity.elapsed() > IROH_REDIAL_AFTER {
                break;
            }
            tokio::select! {
                _ = ticker.tick() => {
                    let payload = local.lock().unwrap().clone();
                    if let Some(payload) = payload {
                        if let Ok(json) = serde_json::to_vec(&payload) {
                            let _ = sender.broadcast(Bytes::from(json)).await;
                        }
                    }
                }
                event = receiver.try_next() => {
                    match event {
                        Ok(Some(Event::Received(msg))) => {
                            last_activity = Instant::now();
                            if let Ok(payload) = serde_json::from_slice::<PresencePayload>(&msg.content) {
                                on_recv(payload);
                            }
                        }
                        Ok(Some(Event::NeighborUp(id))) => {
                            neighbors += 1;
                            last_activity = Instant::now();
                            // Remember this neighbor so we (even the opener) can
                            // re-dial it if the link later stalls.
                            if !dial_ids.contains(&id) {
                                dial_ids.push(id);
                            }
                            on_status(true, neighbors);
                            // Greet the new neighbor with our current state at
                            // once, so their cat shows up without waiting a tick.
                            let payload = local.lock().unwrap().clone();
                            if let Some(payload) = payload {
                                if let Ok(json) = serde_json::to_vec(&payload) {
                                    let _ = sender.broadcast(Bytes::from(json)).await;
                                }
                            }
                        }
                        Ok(Some(Event::NeighborDown(_))) => {
                            neighbors = neighbors.saturating_sub(1);
                            on_status(true, neighbors);
                        }
                        Ok(Some(_)) => {}
                        Ok(None) | Err(_) => break, // stream ended → re-subscribe
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    let _ = router.shutdown().await;
    Ok(())
}

/// WAN transport handle. Owns a tokio runtime on its own thread. Off until
/// [`IrohTransport::start`].
struct IrohTransport {
    local: Arc<Mutex<Option<PresencePayload>>>,
    running: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    /// hex secret key + optional room code to join (`None` → open a new room).
    secret_hex: String,
    room_code: Option<String>,
    /// Optional custom relay URL (empty/`None` → n0's public relays).
    relay_url: Option<String>,
}

impl IrohTransport {
    fn new(secret_hex: String, room_code: Option<String>, relay_url: Option<String>) -> Self {
        Self {
            local: Arc::new(Mutex::new(None)),
            running: Arc::new(AtomicBool::new(false)),
            thread: None,
            secret_hex,
            room_code,
            relay_url,
        }
    }

    fn set_local(&self, payload: PresencePayload) {
        *self.local.lock().unwrap() = Some(payload);
    }

    fn start(
        &mut self,
        on_recv: OnRecv,
        on_room: OnRoom,
        on_status: OnStatus,
        on_debug: OnDebug,
    ) -> Result<(), String> {
        let secret: SecretKey = self
            .secret_hex
            .parse()
            .map_err(|e| format!("bad key: {e}"))?;
        let room = match &self.room_code {
            Some(code) => {
                Some(RoomTicket::from_str(code).map_err(|e| format!("bad room code: {e}"))?)
            }
            None => None,
        };
        self.running.store(true, Ordering::SeqCst);
        let local = self.local.clone();
        let running = self.running.clone();
        let relay_url = self.relay_url.clone();
        self.thread = Some(std::thread::spawn(move || {
            let rt = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(_) => return,
            };
            let _ = rt.block_on(run_room(
                secret, room, relay_url, local, running, on_recv, on_room, on_status, on_debug,
            ));
        }));
        Ok(())
    }

    fn stop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

// ---------------------------------------------------------------------------
// Engine — owns the transport(s) + the live peer table, and pushes `peers`
// snapshots to the frontend. Managed as Tauri state.
// ---------------------------------------------------------------------------

struct PeerEntry {
    payload: PresencePayload,
    last_seen: Instant,
}

/// Managed state binding the transports to the frontend. Both LAN and remote
/// feed the same peer table + `peers` events, so friends from either show up
/// together. Off (no sockets, threads, or endpoints) until the frontend opts
/// in. The stale-sweep runs whenever *either* transport is active.
pub struct Presence {
    lan: Mutex<LanTransport>,
    iroh: Mutex<Option<IrohTransport>>,
    peers: Arc<Mutex<HashMap<String, PeerEntry>>>,
    /// Our own peer id, so a payload that comes back to us (e.g. echoed through
    /// a gossip room) is dropped instead of rendering our own cat as a visitor.
    /// mDNS filters self at discovery, but the iroh path has no such gate.
    self_id: Arc<Mutex<Option<String>>>,
    lan_on: AtomicBool,
    iroh_on: AtomicBool,
    prune_running: Arc<AtomicBool>,
    prune: Mutex<Option<JoinHandle<()>>>,
}

impl Default for Presence {
    fn default() -> Self {
        Self {
            lan: Mutex::new(LanTransport::new()),
            iroh: Mutex::new(None),
            peers: Arc::new(Mutex::new(HashMap::new())),
            self_id: Arc::new(Mutex::new(None)),
            lan_on: AtomicBool::new(false),
            iroh_on: AtomicBool::new(false),
            prune_running: Arc::new(AtomicBool::new(false)),
            prune: Mutex::new(None),
        }
    }
}

impl Presence {
    /// A receive callback that upserts the peer table and re-emits to the UI.
    /// Shared by both transports so a peer from either lands in one roster.
    fn make_on_recv(&self, app: &AppHandle) -> OnRecv {
        let peers = self.peers.clone();
        let self_id = self.self_id.clone();
        let app = app.clone();
        Arc::new(move |p: PresencePayload| {
            // Drop our own payload if it loops back (gossip echo) — otherwise we'd
            // render our own cat as a visiting peer.
            if self_id.lock().unwrap().as_deref() == Some(p.id.as_str()) {
                return;
            }
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
            emit_peers(&app, &peers);
        })
    }

    /// Start the stale-sweep thread if it isn't already running.
    fn ensure_prune(&self, app: &AppHandle) {
        if self.prune_running.swap(true, Ordering::SeqCst) {
            return; // already running
        }
        let peers = self.peers.clone();
        let running = self.prune_running.clone();
        let app = app.clone();
        *self.prune.lock().unwrap() = Some(std::thread::spawn(move || {
            while running.load(Ordering::SeqCst) {
                std::thread::sleep(PRUNE_INTERVAL);
                let removed = {
                    let mut table = peers.lock().unwrap();
                    let before = table.len();
                    table.retain(|_, e| e.last_seen.elapsed() < PEER_STALE);
                    before != table.len()
                };
                if removed {
                    emit_peers(&app, &peers);
                }
            }
        }));
    }

    /// Once both transports are down, stop the sweep and clear the roster.
    fn teardown_if_idle(&self, app: &AppHandle) {
        if self.lan_on.load(Ordering::SeqCst) || self.iroh_on.load(Ordering::SeqCst) {
            return;
        }
        self.prune_running.store(false, Ordering::SeqCst);
        if let Some(h) = self.prune.lock().unwrap().take() {
            let _ = h.join();
        }
        self.peers.lock().unwrap().clear();
        let _ = app.emit("peers", Vec::<PresencePayload>::new());
    }

    // --- LAN ---------------------------------------------------------------

    fn start_lan(&self, app: &AppHandle, payload: PresencePayload) -> Result<(), String> {
        *self.self_id.lock().unwrap() = Some(payload.id.clone());
        self.lan.lock().unwrap().set_local(payload);
        if self.lan_on.load(Ordering::SeqCst) {
            return Ok(()); // already up — the seed above is the live update
        }
        let on_recv = self.make_on_recv(app);
        self.lan.lock().unwrap().start(on_recv)?;
        self.lan_on.store(true, Ordering::SeqCst);
        self.ensure_prune(app);
        Ok(())
    }

    fn stop_lan(&self, app: &AppHandle) {
        if !self.lan_on.swap(false, Ordering::SeqCst) {
            return;
        }
        self.lan.lock().unwrap().stop();
        self.teardown_if_idle(app);
    }

    // --- Remote (iroh rooms) ----------------------------------------------

    /// Open a fresh room (`code = None`) or join an existing one. The base32
    /// room code is delivered to the frontend via the `remote-room-code` event
    /// once the endpoint is up.
    fn remote_start(
        &self,
        app: &AppHandle,
        payload: PresencePayload,
        secret_hex: String,
        code: Option<String>,
        relay_url: Option<String>,
    ) -> Result<(), String> {
        // Rejoin cleanly if already in a room.
        if self.iroh_on.swap(false, Ordering::SeqCst) {
            if let Some(mut t) = self.iroh.lock().unwrap().take() {
                t.stop();
            }
        }

        *self.self_id.lock().unwrap() = Some(payload.id.clone());
        let mut transport = IrohTransport::new(secret_hex, code, relay_url);
        transport.set_local(payload);
        let on_recv = self.make_on_recv(app);
        let app_room = app.clone();
        let on_room: OnRoom = Arc::new(move |room_code: String| {
            let _ = app_room.emit("remote-room-code", room_code);
        });
        let app_status = app.clone();
        let on_status: OnStatus = Arc::new(move |joined: bool, neighbors: usize| {
            let _ = app_status.emit("remote-status", (joined, neighbors));
        });
        let app_debug = app.clone();
        let on_debug: OnDebug = Arc::new(move |msg: String| {
            let _ = app_debug.emit("remote-debug", msg);
        });
        transport.start(on_recv, on_room, on_status, on_debug)?;
        *self.iroh.lock().unwrap() = Some(transport);
        self.iroh_on.store(true, Ordering::SeqCst);
        self.ensure_prune(app);
        Ok(())
    }

    fn remote_leave(&self, app: &AppHandle) {
        if !self.iroh_on.swap(false, Ordering::SeqCst) {
            return;
        }
        if let Some(mut t) = self.iroh.lock().unwrap().take() {
            t.stop();
        }
        self.teardown_if_idle(app);
    }

    /// Push a payload update to whichever transports are live.
    fn publish(&self, payload: PresencePayload) {
        *self.self_id.lock().unwrap() = Some(payload.id.clone());
        if self.lan_on.load(Ordering::SeqCst) {
            self.lan.lock().unwrap().set_local(payload.clone());
        }
        if self.iroh_on.load(Ordering::SeqCst) {
            if let Some(t) = self.iroh.lock().unwrap().as_ref() {
                t.set_local(payload);
            }
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

/// Turn LAN presence on (opt-in) and seed our payload. Idempotent — calling
/// again while running just updates the payload.
#[tauri::command]
pub fn presence_start(
    app: AppHandle,
    state: tauri::State<'_, Presence>,
    payload: PresencePayload,
) -> Result<(), String> {
    state.start_lan(&app, payload)
}

/// Update the coarse payload we broadcast (mood/color/nickname changed). No-op
/// while presence is off. Applies to whichever transports are live.
#[tauri::command]
pub fn presence_publish(state: tauri::State<'_, Presence>, payload: PresencePayload) {
    state.publish(payload);
}

/// Leave the LAN: stop advertising there (remote room, if any, stays).
#[tauri::command]
pub fn presence_stop(app: AppHandle, state: tauri::State<'_, Presence>) {
    state.stop_lan(&app);
}

/// Snapshot of the peers currently online, for an instant paint on mount.
#[tauri::command]
pub fn presence_peers(state: tauri::State<'_, Presence>) -> Vec<PresencePayload> {
    state.peers_snapshot()
}

/// Open a fresh remote room. The base32 room code to share arrives via the
/// `remote-room-code` event once our endpoint is up. `secret_hex` is a stable
/// per-install iroh key (generated + persisted by the frontend).
#[tauri::command]
pub fn presence_remote_open(
    app: AppHandle,
    state: tauri::State<'_, Presence>,
    payload: PresencePayload,
    secret_hex: String,
    relay_url: Option<String>,
) -> Result<(), String> {
    state.remote_start(&app, payload, secret_hex, None, relay_url)
}

/// Join an existing remote room by its base32 code.
#[tauri::command]
pub fn presence_remote_join(
    app: AppHandle,
    state: tauri::State<'_, Presence>,
    payload: PresencePayload,
    secret_hex: String,
    code: String,
    relay_url: Option<String>,
) -> Result<(), String> {
    state.remote_start(&app, payload, secret_hex, Some(code), relay_url)
}

/// Leave the remote room (LAN, if any, stays).
#[tauri::command]
pub fn presence_remote_leave(app: AppHandle, state: tauri::State<'_, Presence>) {
    state.remote_leave(&app);
}
