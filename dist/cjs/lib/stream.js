"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RTCIOStream = void 0;
exports.applyVideoEncodingToSender = applyVideoEncodingToSender;
// crypto.randomUUID is available in all modern browsers and Node ≥19. We
// avoid pulling in the `uuid` package (~9 KB) for a single call site.
function randomId() {
    const c = globalThis.crypto;
    if (c === null || c === void 0 ? void 0 : c.randomUUID)
        return c.randomUUID();
    // Fallback: 8 random hex bytes is plenty to avoid collision per session
    // in the rare environment without WebCrypto.
    return Array.from({ length: 16 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("");
}
class RTCIOStream {
    constructor(idOrMediaStream, mediaStreamOrOptions, options) {
        var _a;
        this.trackChangeCallbacks = [];
        this.addTrackCallbacks = [];
        this.removeTrackCallbacks = [];
        // peerId → senders we created for this stream on that peer. Populated by
        // the library at addTransceiver time; cleared on peer cleanup. Drives
        // setEncoding() runtime updates.
        this._trackedSenders = new Map();
        // peerId → transceivers we created for this stream on that peer. Mirrors
        // _trackedSenders but at the transceiver level so setCodecPreferences()
        // can re-apply codec ordering without renegotiating the whole connection.
        this._trackedTransceivers = new Map();
        // peerId → callback that triggers a fresh offer cycle on that peer.
        // Provided by the Socket on transceiver registration so the stream can
        // kick off renegotiation after a live setCodecPreferences() change.
        this._renegotiateCallbacks = new Map();
        this.applyContentHintTo = (track) => {
            var _a;
            if (track.kind !== 'video')
                return;
            const hint = (_a = this._options.videoEncoding) === null || _a === void 0 ? void 0 : _a.contentHint;
            if (hint === undefined)
                return;
            try {
                track.contentHint = hint;
            }
            catch (_b) {
                // Older browsers without contentHint support — silently no-op.
            }
        };
        // Platform-driven add: dispatch the stream-level onTrackChanged callbacks
        // (back-compat) AND the per-track onTrackAdded callbacks (preferred for new
        // code, since they hand the actual track to the listener and are cleaned
        // up automatically by dispose()).
        this.platformAddTrack = (e) => {
            this.applyContentHintTo(e.track);
            this.onTrackChange();
            this.addTrackCallbacks.forEach(cb => cb(e.track));
        };
        this.platformRemoveTrack = (e) => {
            this.onTrackChange();
            this.removeTrackCallbacks.forEach(cb => cb(e.track));
        };
        this.onTrackChange = () => {
            this.trackChangeCallbacks.forEach(callback => callback(this.mediaStream));
        };
        if (idOrMediaStream instanceof MediaStream) {
            this.id = randomId();
            this.mediaStream = idOrMediaStream;
            this._options = (_a = mediaStreamOrOptions) !== null && _a !== void 0 ? _a : {};
        }
        else {
            this.id = idOrMediaStream;
            this.mediaStream = mediaStreamOrOptions;
            this._options = options !== null && options !== void 0 ? options : {};
        }
        // Apply contentHint to any tracks already on the stream at construction.
        this.applyContentHintToAll();
        // MediaStream's `addtrack` / `removetrack` events only fire when the
        // platform mutates the stream (e.g. WebRTC adds a remote track) — they
        // do *not* fire for programmatic addTrack/removeTrack. We listen anyway
        // to catch the platform-driven case, and the wrapper methods below
        // dispatch onTrackChange explicitly for the user-driven case.
        this.mediaStream.addEventListener('addtrack', this.platformAddTrack);
        this.mediaStream.addEventListener('removetrack', this.platformRemoveTrack);
    }
    /**
     * Read-only view of the current options. Use `setEncoding()` to update
     * encoding fields at runtime.
     */
    get options() {
        return this._options;
    }
    /** @internal Library accessor for the codec-preference callback. */
    _getCodecPreferences() {
        return this._options.codecPreferences;
    }
    /** @internal Library accessor for the current encoding config. */
    _getVideoEncoding() {
        return this._options.videoEncoding;
    }
    /**
     * @internal Called by the Socket when it creates an `RTCRtpSender` for
     * this stream on a peer. Tracks the sender so `setEncoding()` can re-apply
     * params without renegotiation.
     */
    _registerSender(peerId, sender) {
        let set = this._trackedSenders.get(peerId);
        if (!set) {
            set = new Set();
            this._trackedSenders.set(peerId, set);
        }
        set.add(sender);
    }
    /**
     * @internal Called by the Socket alongside `_registerSender`. Tracks the
     * transceiver so `setCodecPreferences()` can re-order codecs on the
     * existing m-line, and stashes a per-peer callback the stream can invoke
     * to kick the offer cycle once the new preferences are in place.
     */
    _registerTransceiver(peerId, transceiver, renegotiate) {
        let set = this._trackedTransceivers.get(peerId);
        if (!set) {
            set = new Set();
            this._trackedTransceivers.set(peerId, set);
        }
        set.add(transceiver);
        // Latest callback wins — they all close over the same peer entry, so
        // any of them is correct. The map only needs one per peer.
        this._renegotiateCallbacks.set(peerId, renegotiate);
    }
    /** @internal Called by the Socket on peer cleanup. */
    _unregisterPeer(peerId) {
        this._trackedSenders.delete(peerId);
        this._trackedTransceivers.delete(peerId);
        this._renegotiateCallbacks.delete(peerId);
    }
    /**
     * @internal Drop a single transceiver+sender from the per-peer registry.
     * Called by the Socket when a transceiver transitions to direction
     * `'inactive'` (its track was removed without a same-kind replacement).
     * Without this, `setCodecPreferences` would later iterate inactive
     * m-lines, and successive remove/add cycles would accumulate dead
     * transceivers in the set even though the platform reuses the slots.
     *
     * The renegotiate callback stays — it is keyed by peer, not transceiver,
     * and is still valid as long as any transceiver for this peer is live.
     * It's cleared in `_unregisterPeer` on full peer cleanup.
     */
    _untrackTransceiver(peerId, transceiver) {
        const tx = this._trackedTransceivers.get(peerId);
        tx === null || tx === void 0 ? void 0 : tx.delete(transceiver);
        if (tx && tx.size === 0)
            this._trackedTransceivers.delete(peerId);
        const senders = this._trackedSenders.get(peerId);
        senders === null || senders === void 0 ? void 0 : senders.delete(transceiver.sender);
        if (senders && senders.size === 0)
            this._trackedSenders.delete(peerId);
    }
    applyContentHintToAll() {
        this.mediaStream.getVideoTracks().forEach(this.applyContentHintTo);
    }
    onTrackChanged(callback) {
        this.trackChangeCallbacks.push(callback);
        return () => {
            this.trackChangeCallbacks = this.trackChangeCallbacks.filter(cb => cb !== callback);
        };
    }
    /**
     * Subscribes to platform-driven track additions on the underlying
     * MediaStream — fires when the WebRTC stack hands the stream a new track
     * (e.g. the remote peer added video after starting with audio only).
     *
     * Programmatic `addTrack()` calls do **not** fire this — use
     * `onTrackChanged` for a callback that covers both. Returns an
     * unsubscribe function. All registered callbacks are also cleared on
     * `dispose()`, so library-internal listeners cannot outlive the wrapper.
     */
    onTrackAdded(callback) {
        this.addTrackCallbacks.push(callback);
        return () => {
            this.addTrackCallbacks = this.addTrackCallbacks.filter(cb => cb !== callback);
        };
    }
    /**
     * Subscribes to platform-driven track removals on the underlying
     * MediaStream — fires when the WebRTC stack drops a track from the stream
     * (e.g. the remote peer stopped sharing screen). Programmatic
     * `removeTrack()` calls do not fire this. Returns an unsubscribe function;
     * callbacks are also cleared on `dispose()`.
     */
    onTrackRemoved(callback) {
        this.removeTrackCallbacks.push(callback);
        return () => {
            this.removeTrackCallbacks = this.removeTrackCallbacks.filter(cb => cb !== callback);
        };
    }
    addTrack(track) {
        this.applyContentHintTo(track);
        this.mediaStream.addTrack(track);
        this.onTrackChange();
        return this;
    }
    removeTrack(track) {
        this.mediaStream.removeTrack(track);
        this.onTrackChange();
        return this;
    }
    /**
     * Swaps the existing track of the same kind (audio/video) for a new one.
     * Returns the displaced track so the caller can `.stop()` it. Use this
     * when the user picks a different mic/cam mid-call — the library hot-swaps
     * via `RTCRtpSender.replaceTrack` on each peer, with no renegotiation.
     */
    replaceTrack(newTrack) {
        var _a;
        const old = (_a = this.mediaStream.getTracks().find(t => t.kind === newTrack.kind)) !== null && _a !== void 0 ? _a : null;
        if (old)
            this.mediaStream.removeTrack(old);
        this.applyContentHintTo(newTrack);
        this.mediaStream.addTrack(newTrack);
        this.onTrackChange();
        return old;
    }
    replace(stream) {
        const oldTracks = [...this.mediaStream.getTracks()];
        oldTracks.forEach(track => this.mediaStream.removeTrack(track));
        stream.getTracks().forEach(track => {
            this.applyContentHintTo(track);
            this.mediaStream.addTrack(track);
        });
        this.onTrackChange();
    }
    /**
     * Update sender-side encoding parameters at runtime, across every peer
     * currently receiving this stream. Merges `partial` over the current
     * config and re-applies to all tracked `RTCRtpSender`s without
     * renegotiation.
     *
     * Use this to react to network conditions (downshift bitrate when the app
     * sees congestion alerts), to flip `degradationPreference` mid-call, or
     * to update `contentHint` when content type changes (e.g. user switches
     * from sharing slides to sharing gameplay).
     *
     * Codec preferences are **not** updatable here — changing codecs requires
     * renegotiation and is out of scope for runtime tuning.
     *
     * @returns A promise that resolves once `setParameters` has been called
     *          on every tracked sender. Individual sender failures are
     *          swallowed (they typically mean the peer just disconnected).
     */
    async setEncoding(partial) {
        this._options = Object.assign(Object.assign({}, this._options), { videoEncoding: Object.assign(Object.assign({}, this._options.videoEncoding), partial) });
        if (partial.contentHint !== undefined) {
            this.applyContentHintToAll();
        }
        const cfg = this._options.videoEncoding;
        const promises = [];
        this._trackedSenders.forEach((set) => {
            set.forEach((sender) => {
                promises.push(applyVideoEncodingToSender(sender, cfg).catch(() => undefined));
            });
        });
        await Promise.all(promises);
    }
    /**
     * Re-order codecs on every peer currently receiving this stream and
     * trigger a single offer/answer round per peer to put the change on the
     * wire. The capture stream is **not** restarted — no track interruption,
     * no fresh `getDisplayMedia` prompt, no permission re-grant.
     *
     * Use this when the user picks a different codec mid-call (e.g. flips
     * VP9 → AV1 while screen-sharing). Encoder-side knobs (bitrate, FPS cap,
     * degradation, contentHint) belong on `setEncoding` — they don't need
     * renegotiation.
     *
     * Pass `undefined` to clear the preference and let the browser default
     * order apply on the next negotiation.
     *
     * @returns A promise that resolves once `setCodecPreferences` has been
     *          called on every tracked transceiver and per-peer offers have
     *          been kicked off. Awaiting it does **not** wait for the offers
     *          to complete — that's an out-of-band signaling round.
     */
    async setCodecPreferences(cb) {
        this._options = Object.assign(Object.assign({}, this._options), { codecPreferences: cb });
        // Resolve sender capabilities once per kind — cheap, but every call
        // hits a browser API so cache for the loop. `getCapabilities` is
        // declared non-optional in lib.dom.d.ts, but absent on older browsers,
        // so we cast through `any` (matching the rtc.ts call site) to make
        // the optional-chain legal under strict TS.
        const capsCache = {};
        const capsFor = (kind) => {
            var _a, _b, _c;
            if (kind in capsCache)
                return capsCache[kind];
            const c = (_b = (_a = RTCRtpSender).getCapabilities) === null || _b === void 0 ? void 0 : _b.call(_a, kind);
            capsCache[kind] = (_c = c === null || c === void 0 ? void 0 : c.codecs) !== null && _c !== void 0 ? _c : undefined;
            return capsCache[kind];
        };
        this._trackedTransceivers.forEach((set, peerId) => {
            let touched = false;
            set.forEach((transceiver) => {
                var _a, _b, _c;
                if (typeof transceiver.setCodecPreferences !== 'function')
                    return;
                // Skip transceivers that won't carry media in the next offer:
                //   - 'stopped' / 'closed' transceivers (terminal states)
                //   - 'inactive' direction (codec list ignored on inactive m-lines)
                // They should normally be untracked already, but defending here
                // keeps a stale entry from causing a wasted call or surfacing a
                // browser-thrown InvalidStateError on `setCodecPreferences`.
                if (transceiver.currentDirection === 'stopped')
                    return;
                if (transceiver.direction === 'inactive' || transceiver.direction === 'stopped')
                    return;
                const trackKind = (_b = (_a = transceiver.sender.track) === null || _a === void 0 ? void 0 : _a.kind) !== null && _b !== void 0 ? _b : (_c = transceiver.receiver.track) === null || _c === void 0 ? void 0 : _c.kind;
                const kind = trackKind === 'audio' ? 'audio' : 'video';
                const codecs = capsFor(kind);
                if (!codecs || codecs.length === 0)
                    return;
                try {
                    if (cb) {
                        const ordered = cb(codecs.slice(), kind);
                        if (ordered && ordered.length > 0) {
                            transceiver.setCodecPreferences(ordered);
                            touched = true;
                        }
                    }
                    else {
                        // Clearing: spec says passing [] resets to the default order.
                        transceiver.setCodecPreferences([]);
                        touched = true;
                    }
                }
                catch (_d) {
                    // Browser refused this ordering — leave the previous one in place.
                }
            });
            // Skip the renegotiation if no transceiver actually accepted a
            // new ordering — a wasted offer/answer round on the wire would
            // just re-encode the same codec choice.
            if (!touched)
                return;
            const trigger = this._renegotiateCallbacks.get(peerId);
            if (trigger) {
                try {
                    trigger();
                }
                catch ( /* swallow — peer may be tearing down */_a) { /* swallow — peer may be tearing down */ }
            }
        });
    }
    /**
     * Detaches the platform-track-event listeners and drops user-registered
     * callbacks. Call when you're done with the wrapper but the underlying
     * MediaStream lives on (e.g. handing it off to a `<video>` element). The
     * library calls this internally when a peer disconnects.
     */
    dispose() {
        this.mediaStream.removeEventListener('addtrack', this.platformAddTrack);
        this.mediaStream.removeEventListener('removetrack', this.platformRemoveTrack);
        this.trackChangeCallbacks = [];
        this.addTrackCallbacks = [];
        this.removeTrackCallbacks = [];
    }
    toJSON() {
        return `[RTCIOStream] ${this.id}`;
    }
}
exports.RTCIOStream = RTCIOStream;
/**
 * Applies a {@link VideoEncodingConfig} to a single `RTCRtpSender`. Exported
 * for use by the library; user code should call `RTCIOStream.setEncoding`
 * instead.
 *
 * Skips senders whose track is not video — encoding params on audio senders
 * are valid in the spec but the config is shaped around video tuning.
 *
 * @internal
 */
async function applyVideoEncodingToSender(sender, cfg) {
    if (sender.track && sender.track.kind !== 'video')
        return;
    const params = sender.getParameters();
    if (cfg.degradationPreference !== undefined) {
        params.degradationPreference = cfg.degradationPreference;
    }
    // `getParameters()` may return `encodings: undefined` on a freshly created
    // sender in some browser/state combos — give it a one-entry default so we
    // have somewhere to write.
    if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
    }
    for (const enc of params.encodings) {
        if (cfg.maxBitrate !== undefined)
            enc.maxBitrate = cfg.maxBitrate;
        if (cfg.maxFramerate !== undefined)
            enc.maxFramerate = cfg.maxFramerate;
        if (cfg.priority !== undefined)
            enc.priority = cfg.priority;
        if (cfg.networkPriority !== undefined)
            enc.networkPriority = cfg.networkPriority;
        if (cfg.scaleResolutionDownBy !== undefined) {
            enc.scaleResolutionDownBy = cfg.scaleResolutionDownBy;
        }
    }
    await sender.setParameters(params);
}
