export declare const RtcioEvents: {
    readonly OFFER: "#rtcio:offer";
    readonly ANSWER: "#rtcio:answer";
    readonly CANDIDATE: "#rtcio:candidate";
    readonly MESSAGE: "#rtcio:message";
    readonly STREAM_META: "#rtcio:stream-meta";
    readonly INIT_OFFER: "#rtcio:init-offer";
};
export declare const INTERNAL_EVENT_PREFIX = "#rtcio:";
export declare const CTRL_CHANNEL_LABEL = "rtcio:ctrl";
export declare const CUSTOM_CHANNEL_PREFIX = "rtcio:ch:";
export declare const RESERVED_EVENTS: Set<string>;
