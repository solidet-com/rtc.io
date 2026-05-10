type BasePayload = {
    source: string;
    target: string;
};
export type MessagePayload<T = any> = {
    data: T;
} & BasePayload;
export type GetEventPayload = MessagePayload<{
    mid: string;
    events?: Record<string, any>;
}>;
export {};
