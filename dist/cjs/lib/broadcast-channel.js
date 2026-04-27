"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RTCIOBroadcastChannel = void 0;
class RTCIOBroadcastChannel {
    constructor() {
        this._peers = new Map();
        this._globalListeners = new Map();
        this._closed = false;
    }
    _addPeer(peerId, channel) {
        if (this._closed)
            return;
        // Replace any existing entry for this peer (e.g. ICE restart re-attached)
        this._peers.set(peerId, channel);
        this._globalListeners.forEach((handlers, event) => {
            handlers.forEach((h) => channel.on(event, h));
        });
        channel.on("drain", () => this._dispatch("drain"));
        channel.on("error", (e) => this._dispatch("error", e));
        channel.on("close", () => this._removePeer(peerId));
    }
    _removePeer(peerId) {
        if (!this._peers.has(peerId))
            return;
        this._peers.delete(peerId);
        this._dispatch("peer-left", peerId);
        if (this._peers.size === 0 && !this._closed) {
            this._dispatch("close");
        }
    }
    emit(eventName, ...args) {
        this._peers.forEach((ch) => ch.emit(eventName, ...args));
    }
    send(data) {
        let allOk = true;
        this._peers.forEach((ch) => {
            if (!ch.send(data))
                allOk = false;
        });
        return allOk;
    }
    on(event, handler) {
        let list = this._globalListeners.get(event);
        if (!list) {
            list = [];
            this._globalListeners.set(event, list);
        }
        list.push(handler);
        this._peers.forEach((ch) => ch.on(event, handler));
        return this;
    }
    off(event, handler) {
        const list = this._globalListeners.get(event);
        if (list) {
            const idx = list.indexOf(handler);
            if (idx !== -1)
                list.splice(idx, 1);
        }
        this._peers.forEach((ch) => ch.off(event, handler));
        return this;
    }
    once(event, handler) {
        const wrapper = (...args) => {
            this.off(event, wrapper);
            handler(...args);
        };
        return this.on(event, wrapper);
    }
    close() {
        if (this._closed)
            return;
        this._closed = true;
        this._peers.forEach((ch) => ch.close());
        this._peers.clear();
        this._dispatch("close");
    }
    get peerCount() {
        return this._peers.size;
    }
    get closed() {
        return this._closed;
    }
    _dispatch(event, data) {
        const list = this._globalListeners.get(event);
        if (!list)
            return;
        list.slice().forEach((h) => {
            try {
                h(data);
            }
            catch (e) {
                console.error(`[rtc-io] RTCIOBroadcastChannel listener [${event}]`, e);
            }
        });
    }
}
exports.RTCIOBroadcastChannel = RTCIOBroadcastChannel;
