# Self-hosted relay (for stubborn networks)

clawd's remote rooms connect **peer-to-peer over [iroh](https://iroh.computer)**.
When two peers can't hole-punch a direct link (most home + mobile networks can),
iroh falls back to a **relay** that shuttles the (tiny, coarse) presence packets
between them. By default clawd uses **n0's free public relays**, so you don't
need to run anything.

But some networks — corporate Wi-Fi, strict firewalls, some VPNs — **block the
public relay hostnames**. When that happens the room is stuck on
**🟡 (릴레이 없음)**: both sides join the room but never see each other, because
neither can reach a common relay.

The fix is to run **your own iroh relay** on a host both peers *can* reach
(a cheap/free VPS with a domain on port 443 usually sails through, since it
looks like ordinary HTTPS), and point both clawds at it.

> You only need this if you're stuck on 🟡 across different networks. On the
> same LAN, or when the public relays work, skip this entirely.

---

## 1. Get a host + domain

Any always-on Linux box with a public IP and a DNS name works. Free / cheap
options that are known to work:

- **Oracle Cloud "Always Free"** — an ARM VM, free forever. Generous enough for
  a relay.
- **Fly.io**, **Hetzner**, **a $4–6/mo VPS**, a Raspberry Pi on a port-forwarded
  home connection, etc.

Point a DNS `A`/`AAAA` record (e.g. `relay.example.com`) at the host. You need
**inbound TCP 443** open (and it helps to allow **UDP 3478** for QUIC address
discovery / better hole-punching).

## 2. Install the relay binary

The relay ships with iroh. On the host:

```sh
# Rust toolchain (if not present)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"

# Install the relay from crates.io (matches the iroh version clawd uses)
cargo install iroh-relay --version 0.91 --bin iroh-relay
```

## 3. Configure + run it

Create `relay.toml`:

```toml
# Listen for HTTPS/relay traffic on 443.
http_bind_addr = "0.0.0.0:80"     # for the ACME/Let's Encrypt HTTP challenge
https_bind_addr = "0.0.0.0:443"

# Automatic TLS via Let's Encrypt for your domain.
[tls]
hostname = "relay.example.com"
cert_mode = "letsencrypt"
prod_tls = true
contact = "you@example.com"

# Enable QUIC address discovery (improves direct-connection success).
[quic]
```

Run it (as root or with `CAP_NET_BIND_SERVICE` so it can bind :443):

```sh
sudo iroh-relay --config-path relay.toml
```

For a long-running deploy, wrap it in a `systemd` unit or a container so it
restarts on reboot. Confirm it's up:

```sh
curl -I https://relay.example.com    # expect an HTTP response from the relay
```

> Exact config keys can shift between iroh releases — if a key is rejected, run
> `iroh-relay --help` and check the
> [iroh-relay docs](https://docs.rs/iroh-relay) for your installed version.

## 4. Point clawd at it (both peers!)

In each clawd's **상세 · 설정 → 🌐 원격 방 → 고급 · 커스텀 릴레이**, enter the
**same** URL:

```
https://relay.example.com
```

Then open / join the room as usual. The 🔧 diagnostic line should now read
**"커스텀 릴레이 https://relay.example.com"** on both machines, and the status
should go 🟢.

> **Both peers must set the same URL.** A self-hosted relay doesn't mesh with
> n0's public relays, so it has to be the shared home relay on both sides.
> Leaving the field empty uses n0's public relays (the default).

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| 🔧 "커스텀 릴레이에 못 붙음" | Relay not running, DNS not resolving, or 443 blocked inbound. `curl -I https://<host>` from another network. |
| Still 🟡 with a relay set | Only one peer set the URL, or the two URLs differ. Both must match exactly. |
| Works on hotspot, not on office Wi-Fi | That network blocks outbound 443 to your relay too — rare, but then the network is the limit. |
| Cert errors on startup | Let's Encrypt needs inbound **:80** reachable for the HTTP-01 challenge, and the DNS record must already point at the host. |

The relay only ever sees clawd's **coarse presence packets** (nickname, coat
color, mood, activity bucket) — never token counts, cost, or project names,
same as everything else in social mode.
