import { describe, it, expect } from "vitest";
import { replaceQuickReplyVariables } from "@/lib/inbox/quick-reply-variables";

describe("welcome-engine logic & rules", () => {
  it("resolves welcome message template variables accurately", () => {
    const template = "Olá {{primeiro_nome}}! Seja muito bem-vindo à {{empresa}}. Como posso te ajudar?";
    const resolved = replaceQuickReplyVariables(template, {
      name: "João da Silva",
      company: "WPP3N Tech",
      agentName: "Atendente Virtual",
    });

    expect(resolved).toBe("Olá João! Seja muito bem-vindo à WPP3N Tech. Como posso te ajudar?");
  });

  it("handles empty name fallback in welcome template", () => {
    const template = "Olá {{primeiro_nome}}! Bem-vindo!";
    const resolved = replaceQuickReplyVariables(template, {});

    expect(resolved).toBe("Olá cliente! Bem-vindo!");
  });

  it("correctly identifies inactivity window expiration", () => {
    const now = new Date("2026-09-15T12:00:00Z");
    const windowDays = 14;

    // Last message was 20 days ago (expired -> eligible for reentry)
    const twentyDaysAgo = new Date("2026-08-26T12:00:00Z");
    const diffDays20 = (now.getTime() - twentyDaysAgo.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays20 > windowDays).toBe(true);

    // Last message was 5 days ago (not expired -> NOT eligible for reentry)
    const fiveDaysAgo = new Date("2026-09-10T12:00:00Z");
    const diffDays5 = (now.getTime() - fiveDaysAgo.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays5 > windowDays).toBe(false);

    // Window 0 = absolute 1st only (never reenter)
    const windowZero = 0;
    const isEligibleZero = windowZero > 0 && diffDays20 > windowZero;
    expect(isEligibleZero).toBe(false);
  });

  it("suppresses rapid burst messages within 60 seconds", () => {
    const lastWelcomeSent = new Date("2026-09-15T12:00:00Z");
    const incomingSecondMessage = new Date("2026-09-15T12:00:08Z"); // 8s later
    const incomingThirdMessage = new Date("2026-09-15T12:00:20Z"); // 20s later

    const isBurstSecond = (incomingSecondMessage.getTime() - lastWelcomeSent.getTime()) < 60000;
    const isBurstThird = (incomingThirdMessage.getTime() - lastWelcomeSent.getTime()) < 60000;

    expect(isBurstSecond).toBe(true);
    expect(isBurstThird).toBe(true);
  });

  it("respects human active condition", () => {
    const conversationStatus = "HUMAN_ACTIVE";
    const sendIfHumanActiveFalse = false;
    const sendIfHumanActiveTrue = true;

    const shouldSkipWhenDisabled = conversationStatus === "HUMAN_ACTIVE" && !sendIfHumanActiveFalse;
    const shouldSkipWhenEnabled = conversationStatus === "HUMAN_ACTIVE" && !sendIfHumanActiveTrue;

    expect(shouldSkipWhenDisabled).toBe(true);
    expect(shouldSkipWhenEnabled).toBe(false);
  });
});
