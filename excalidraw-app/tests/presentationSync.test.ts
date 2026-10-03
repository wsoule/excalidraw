import { vi } from "vitest";

import {
  broadcastPresentation,
  canBroadcastPresentation,
  onPresentationMessage,
  receivePresentationMessage,
  setPresentationSender,
} from "../presentation/presentationSync";

describe("presentationSync", () => {
  afterEach(() => setPresentationSender(null));

  it("broadcasts only while connected to a collaboration room", () => {
    const send = vi.fn();
    broadcastPresentation({ kind: "end", sessionId: "s" });
    expect(canBroadcastPresentation()).toBe(false);

    setPresentationSender(send);
    expect(canBroadcastPresentation()).toBe(true);
    broadcastPresentation({ kind: "end", sessionId: "s" });
    broadcastPresentation(
      { kind: "laser", sessionId: "s", point: [1, 2] },
      true,
    );

    expect(send.mock.calls).toEqual([
      [{ kind: "end", sessionId: "s" }, false],
      [{ kind: "laser", sessionId: "s", point: [1, 2] }, true],
    ]);
  });

  it("delivers received messages to subscribers until they unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = onPresentationMessage(listener);
    const message = {
      kind: "end" as const,
      sessionId: "s",
      socketId: "socket",
      username: "Ada",
    };

    receivePresentationMessage(message);
    unsubscribe();
    receivePresentationMessage(message);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(message);
  });
});
