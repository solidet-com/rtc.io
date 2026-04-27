export const RtcioEvents = {
    OFFER:       "#rtcio:offer",
    ANSWER:      "#rtcio:answer",
    CANDIDATE:   "#rtcio:candidate",
    MESSAGE:     "#rtcio:message",
    STREAM_META: "#rtcio:stream-meta",
    INIT_OFFER:  "#rtcio:init-offer",
} as const;

export const INTERNAL_EVENT_PREFIX = "#rtcio:";
export const CTRL_CHANNEL_LABEL    = "rtcio:ctrl";
export const CUSTOM_CHANNEL_PREFIX = "rtcio:ch:";
