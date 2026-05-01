/**
 * Per-stream sender-side encoding tuning. Forwarded to every peer's
 * `RTCRtpSender` for the video tracks of this stream — applied once on
 * transceiver creation, and re-applied on `setEncoding()` for runtime updates.
 *
 * Defaults are the browser's defaults — every field is independently optional.
 *
 * Designed for the high-motion (game/screen-share) case where the encoder
 * starves on bitrate and starts sacrificing FPS. The relevant levers, in
 * priority order:
 *
 *  1. `degradationPreference: 'maintain-framerate'` — drop resolution before
 *     FPS when bandwidth is tight. Single biggest FPS win for game streaming.
 *  2. `contentHint: 'motion'` + `maxBitrate` ~6–10 Mbps for 1080p60 — tells
 *     the encoder to favour temporal quality and lifts the default ceiling.
 *  3. `priority` / `networkPriority: 'high'` — sets DSCP marks and intra-PC
 *     scheduling; free latency win on networks that honour it.
 *
 * See README "Game streaming / high-motion tuning" for the full playbook.
 */
export interface VideoEncodingConfig {
    /**
     * Maximum encoder bitrate, in bits/sec. Default WebRTC ceiling is ~1–2 Mbps
     * (VP8) which is too low for 1080p60 motion. Set to ~70–80% of measured
     * uplink — going higher buys nothing because GCC will throttle anyway.
     *
     * Examples: `8_000_000` (1080p60 game), `4_000_000` (720p60), `2_500_000`
     * (720p30 talking-head).
     */
    maxBitrate?: number;
    /**
     * Maximum sender framerate (Hz). Caps what the encoder will emit even if
     * the source produces more. Useful to pin a 30 Hz ceiling on a 60 Hz
     * source to halve bitrate.
     */
    maxFramerate?: number;
    /**
     * What the encoder sacrifices when bandwidth or CPU runs short.
     *
     * - `'maintain-framerate'` — drop resolution first. **Recommended for
     *   games and high-motion content** where stutter is more visible than
     *   softness.
     * - `'maintain-resolution'` — drop FPS first. Right for screen-share of
     *   text/code where pixel-sharpness beats smoothness.
     * - `'balanced'` — the browser default. Sacrifices FPS for high-motion
     *   content, which is exactly what game streaming does *not* want.
     */
    degradationPreference?: RTCDegradationPreference;
    /**
     * `MediaStreamTrack.contentHint` — applied to every video track of the
     * stream (now and as new tracks are added). Tells the encoder what kind
     * of content it's compressing so it can pick tunings:
     *
     * - `'motion'` — game streaming, sports video.
     * - `'detail'` — code editors, document review, fine UI.
     * - `'text'` — same as `'detail'` but emphasised for OCR readability.
     * - `''` (empty string) — clear the hint.
     *
     * @see https://www.w3.org/TR/mst-content-hint/
     */
    contentHint?: '' | 'motion' | 'detail' | 'text';
    /**
     * Intra-RTCPeerConnection scheduling priority. Affects how this stream is
     * paced relative to other senders on the same connection.
     */
    priority?: RTCPriorityType;
    /**
     * Network-layer priority. Maps to DSCP marks ([webrtc-priority]) — on
     * networks that honour them, your packets jump ahead of bulk traffic.
     * No-op when ignored, free latency win when it works.
     */
    networkPriority?: RTCPriorityType;
    /**
     * Resolution downscale factor (>= 1). The browser captures at the
     * source's resolution, then divides each axis by this number before
     * encoding. `2` halves both dimensions (quartering pixels) — useful as a
     * cheap bandwidth cut without changing capture constraints.
     */
    scaleResolutionDownBy?: number;
}
/**
 * Callback for selecting / reordering codecs on each transceiver created for
 * this stream. Called synchronously inside `addTransceiver` — the returned
 * order is what shows up in the next SDP offer, so it must run before
 * negotiation.
 *
 * @param capabilities Codec list reported by `RTCRtpSender.getCapabilities(kind)`.
 *                     Already filtered to non-empty MIME types.
 * @param kind         `'video'` or `'audio'` — same callback is invoked for
 *                     both kinds when the stream contains both.
 * @returns The codecs to prefer, in preferred order. Codecs not in the
 *          returned list are dropped from this transceiver.
 *
 * @example
 * ```ts
 * const stream = new RTCIOStream(media, {
 *   codecPreferences: (caps, kind) => {
 *     if (kind !== 'video') return caps;
 *     // Prefer VP9 → AV1 → VP8; keep H.264 as a fallback at the end.
 *     const order = ['video/VP9', 'video/AV1', 'video/VP8', 'video/H264'];
 *     return order.flatMap(mime =>
 *       caps.filter(c => c.mimeType.toLowerCase() === mime.toLowerCase())
 *     );
 *   },
 * });
 * ```
 */
export type CodecPreferenceCallback = (capabilities: RTCRtpCodec[], kind: 'video' | 'audio') => RTCRtpCodec[];
export interface RTCIOStreamOptions {
    /** Sender-side video encoding tuning. See {@link VideoEncodingConfig}. */
    videoEncoding?: VideoEncodingConfig;
    /** Codec preference selector. See {@link CodecPreferenceCallback}. */
    codecPreferences?: CodecPreferenceCallback;
}
export declare class RTCIOStream {
    id: string;
    mediaStream: MediaStream;
    private trackChangeCallbacks;
    private addTrackCallbacks;
    private removeTrackCallbacks;
    private _options;
    private _trackedSenders;
    constructor(mediaStream: MediaStream, options?: RTCIOStreamOptions);
    constructor(id: string, mediaStream: MediaStream, options?: RTCIOStreamOptions);
    /**
     * Read-only view of the current options. Use `setEncoding()` to update
     * encoding fields at runtime.
     */
    get options(): Readonly<RTCIOStreamOptions>;
    /** @internal Library accessor for the codec-preference callback. */
    _getCodecPreferences(): CodecPreferenceCallback | undefined;
    /** @internal Library accessor for the current encoding config. */
    _getVideoEncoding(): VideoEncodingConfig | undefined;
    /**
     * @internal Called by the Socket when it creates an `RTCRtpSender` for
     * this stream on a peer. Tracks the sender so `setEncoding()` can re-apply
     * params without renegotiation.
     */
    _registerSender(peerId: string, sender: RTCRtpSender): void;
    /** @internal Called by the Socket on peer cleanup. */
    _unregisterPeer(peerId: string): void;
    private applyContentHintTo;
    private applyContentHintToAll;
    private platformAddTrack;
    private platformRemoveTrack;
    private onTrackChange;
    onTrackChanged(callback: (stream: MediaStream) => void): () => void;
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
    onTrackAdded(callback: (track: MediaStreamTrack) => void): () => void;
    /**
     * Subscribes to platform-driven track removals on the underlying
     * MediaStream — fires when the WebRTC stack drops a track from the stream
     * (e.g. the remote peer stopped sharing screen). Programmatic
     * `removeTrack()` calls do not fire this. Returns an unsubscribe function;
     * callbacks are also cleared on `dispose()`.
     */
    onTrackRemoved(callback: (track: MediaStreamTrack) => void): () => void;
    addTrack(track: MediaStreamTrack): this;
    removeTrack(track: MediaStreamTrack): this;
    /**
     * Swaps the existing track of the same kind (audio/video) for a new one.
     * Returns the displaced track so the caller can `.stop()` it. Use this
     * when the user picks a different mic/cam mid-call — the library hot-swaps
     * via `RTCRtpSender.replaceTrack` on each peer, with no renegotiation.
     */
    replaceTrack(newTrack: MediaStreamTrack): MediaStreamTrack | null;
    replace(stream: MediaStream): void;
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
    setEncoding(partial: Partial<VideoEncodingConfig>): Promise<void>;
    /**
     * Detaches the platform-track-event listeners and drops user-registered
     * callbacks. Call when you're done with the wrapper but the underlying
     * MediaStream lives on (e.g. handing it off to a `<video>` element). The
     * library calls this internally when a peer disconnects.
     */
    dispose(): void;
    toJSON(): string;
}
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
export declare function applyVideoEncodingToSender(sender: RTCRtpSender, cfg: VideoEncodingConfig): Promise<void>;
