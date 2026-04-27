export const RtcioEvents = {
    OFFER: "#rtcio:offer",
    ANSWER: "#rtcio:answer",
    CANDIDATE: "#rtcio:candidate",
    MESSAGE: "#rtcio:message",
    STREAM_META: "#rtcio:stream-meta",
    INIT_OFFER: "#rtcio:init-offer",
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
