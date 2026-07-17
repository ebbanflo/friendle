// Transport abstraction. Two interchangeable implementations:
//   SupabaseTransport - production: Supabase Realtime broadcast + presence.
//   LocalTransport    - BroadcastChannel + heartbeat presence (?t=local).
//                       Used by ALL automated tests; zero network.
//
// Contract:
//   await t.connect()          resolves when joined, rejects if unreachable
//   t.send(payload)            broadcast payload to all OTHER peers
//   t.onMessage(cb)            cb(payload) for peers' payloads (never your own)
//   t.onPresence(cb)           cb(Set<peerId>) other peers currently present
//   await t.leave()
//
// IMPORTANT: neither transport echoes your own sends back to you. Anything
// that must also apply locally goes through Net.emit(), which dispatches the
// envelope to local handlers AND sends it.

import {
  SUPABASE_URL, SUPABASE_KEY, CHANNEL_PREFIX,
  HEARTBEAT_MS, PRESENCE_TIMEOUT_MS, ERR_NAPPING,
} from './config.js';
import { EVENT_NAME } from './protocol.js';

export class LocalTransport {
  constructor(code, self) {
    this.code = code;
    this.self = self;
    this.msgCbs = [];
    this.presCbs = [];
    this.peers = new Map(); // id -> lastSeen
    this.lastHb = 0;
  }

  async connect() {
    this.bc = new BroadcastChannel('friendle-local:' + this.code);
    this.bc.onmessage = (e) => {
      const m = e.data;
      if (m && m.__hb) {
        const known = this.peers.has(m.__hb.id);
        this.peers.set(m.__hb.id, Date.now());
        if (!known) {
          this._firePresence();
          this._heartbeat(true); // let the newcomer see us fast
        }
        return;
      }
      for (const cb of this.msgCbs) cb(m);
    };
    this._hbTimer = setInterval(() => {
      this._heartbeat();
      const cut = Date.now() - PRESENCE_TIMEOUT_MS;
      let changed = false;
      for (const [id, seen] of this.peers) {
        if (seen < cut) { this.peers.delete(id); changed = true; }
      }
      if (changed) this._firePresence();
    }, HEARTBEAT_MS);
    this._heartbeat(true);
  }

  _heartbeat(force = false) {
    const t = Date.now();
    if (!force && t - this.lastHb < HEARTBEAT_MS / 2) return;
    this.lastHb = t;
    try { this.bc.postMessage({ __hb: { id: this.self.id } }); } catch { /* channel closed */ }
  }

  _firePresence() {
    const present = new Set(this.peers.keys());
    for (const cb of this.presCbs) cb(present);
  }

  send(payload) { try { this.bc.postMessage(payload); } catch { /* channel closed */ } }
  onMessage(cb) { this.msgCbs.push(cb); }
  onPresence(cb) { this.presCbs.push(cb); }

  async leave() {
    clearInterval(this._hbTimer);
    try { this.bc.close(); } catch { /* already closed */ }
  }
}

let sbClient = null;

export class SupabaseTransport {
  constructor(code, self) {
    this.code = code;
    this.self = self;
    this.msgCbs = [];
    this.presCbs = [];
  }

  async connect() {
    if (!window.supabase) throw new Error('supabase-js failed to load');
    if (!sbClient) {
      sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        realtime: { params: { eventsPerSecond: 20 } },
      });
    }
    // One public channel per room; `friendle:` prefix keeps rooms disjoint
    // from the sibling game's `hmmm:` channels in the same project.
    this.channel = sbClient.channel(CHANNEL_PREFIX + this.code, {
      config: { broadcast: { self: false, ack: false }, presence: { key: this.self.id } },
    });
    this.channel.on('broadcast', { event: EVENT_NAME }, ({ payload }) => {
      for (const cb of this.msgCbs) cb(payload);
    });
    const sync = () => {
      const state = this.channel.presenceState();
      const present = new Set(Object.keys(state));
      present.delete(this.self.id);
      for (const cb of this.presCbs) cb(present);
    };
    this.channel.on('presence', { event: 'sync' }, sync);
    this.channel.on('presence', { event: 'join' }, sync);
    this.channel.on('presence', { event: 'leave' }, sync);

    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(ERR_NAPPING)), 12000);
      this.channel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(to);
          try { await this.channel.track({ id: this.self.id, name: this.self.name }); } catch { /* non-fatal */ }
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(to);
          reject(new Error(ERR_NAPPING));
        }
      });
    });
  }

  send(payload) {
    this.channel.send({ type: 'broadcast', event: EVENT_NAME, payload });
  }
  onMessage(cb) { this.msgCbs.push(cb); }
  onPresence(cb) { this.presCbs.push(cb); }

  async leave() {
    try { await this.channel.unsubscribe(); } catch { /* already gone */ }
  }
}

export function makeTransport(code, self, kind) {
  return kind === 'local' ? new LocalTransport(code, self) : new SupabaseTransport(code, self);
}

// Net wraps a transport with the {t, from, d} envelope and local dispatch.
export class Net {
  constructor(transport, selfId) {
    this.transport = transport;
    this.selfId = selfId;
    this.handlers = new Map(); // t -> [fn]
    this.anyHandlers = [];
    transport.onMessage((env) => this.dispatch(env));
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }
  onAny(fn) { this.anyHandlers.push(fn); }

  dispatch(env) {
    if (!env || typeof env.t !== 'string') return;
    for (const fn of this.anyHandlers) fn(env);
    const list = this.handlers.get(env.t);
    if (list) for (const fn of list) fn(env.d, env.from);
  }

  // Send to peers AND handle locally (transports never echo your own sends).
  emit(type, d = {}) {
    const env = { t: type, from: this.selfId, d };
    this.transport.send(env);
    this.dispatch(env);
  }

  // Send only - for intents aimed at the host that the sender must NOT
  // process itself (e.g. a guest's join/guess).
  send(type, d = {}) {
    this.transport.send({ t: type, from: this.selfId, d });
  }

  hasHandler(type) { return this.handlers.has(type); }
}
