export const RtcioEvents = {
    OFFER: "#rtcio:offer",
    ANSWER: "#rtcio:answer",
    CANDIDATE: "#rtcio:candidate",
    MESSAGE: "#rtcio:message",
    STREAM_META: "#rtcio:stream-meta",
    INIT_OFFER: "#rtcio:init-offer",
    // Server → client. Fast-path notification that a socket disconnected, so
    // peers can tear down the matching RTCPeerConnection without waiting on
    // ICE consent-freshness (~30 s). The library also has a WebRTC-level
    // watchdog that catches the same condition when this signal is missing
    // (custom server, dropped packets), so this event is an optimisation
    // rather than a load-bearing dependency.
    PEER_LEFT: "#rtcio:peer-left",
};
export const INTERNAL_EVENT_PREFIX = "#rtcio:";
export const CTRL_CHANNEL_LABEL = "rtcio:ctrl";
export const CUSTOM_CHANNEL_PREFIX = "rtcio:ch:";
// Library-emitted lifecycle events. Filtered on the receive side of the ctrl
// DataChannel so a peer cannot spoof them — otherwise a malicious peer could
// fire fake "peer-connect" or "track-added" handlers on the victim.
export const RESERVED_EVENTS = new Set([
    "peer-connect",
    "peer-disconnect",
    "track-added",
]);
