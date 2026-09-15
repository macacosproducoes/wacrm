import { describe, it, expect } from "vitest";
import { getDefaultColorForKind } from "./quick-reply-colors";
import { replaceQuickReplyVariables } from "./quick-reply-variables";
import type { QuickReplySequenceStep } from "@/types";

describe("Quick Replies Central Suite", () => {
  it("assigns appropriate brand colors for each quick reply kind", () => {
    expect(getDefaultColorForKind("text")).toBe("#EAB308"); // 🟨
    expect(getDefaultColorForKind("audio")).toBe("#A855F7"); // 🟪
    expect(getDefaultColorForKind("sequence")).toBe("#F97316"); // 🟧
    expect(getDefaultColorForKind("image")).toBe("#3B82F6"); // 🟦
    expect(getDefaultColorForKind("video")).toBe("#06B6D4"); // 🟩
    expect(getDefaultColorForKind("document")).toBe("#EF4444"); // 🟥
    expect(getDefaultColorForKind("interactive")).toBe("#10B981"); // 🩵
  });

  it("replaces all variable tokens correctly for ZapPlus sequences", () => {
    const sequenceSteps: QuickReplySequenceStep[] = [
      { id: "1", order: 1, type: "text", content: "Olá {{primeiro_nome}}, bem-vindo à {{empresa}}!", delay_seconds: 0 },
      { id: "2", order: 2, type: "audio", media_url: "https://example.com/audio.ogg", delay_seconds: 3 },
      { id: "3", order: 3, type: "text", content: "Meu nome é {{atendente}}. Qual seu melhor e-mail?", delay_seconds: 2 },
    ];

    const context = {
      name: "Roberta Albuquerque",
      company: "Acme Corp",
      agentName: "Carlos Suporte",
    };

    const step1Content = replaceQuickReplyVariables(sequenceSteps[0].content || "", context);
    const step3Content = replaceQuickReplyVariables(sequenceSteps[2].content || "", context);

    expect(step1Content).toBe("Olá Roberta, bem-vindo à Acme Corp!");
    expect(step3Content).toBe("Meu nome é Carlos Suporte. Qual seu melhor e-mail?");
  });

  it("handles empty or missing context variables gracefully without crash", () => {
    const text = "Olá {{nome}}, eu sou {{atendente}}.";
    const rendered = replaceQuickReplyVariables(text, {});

    expect(rendered).toBe("Olá cliente, eu sou Atendente.");
  });

  it("handles single-brace legacy syntax compatibility", () => {
    const text = "{saudacao}, {primeiro_nome}! Aqui é da {empresa}.";
    const rendered = replaceQuickReplyVariables(text, {
      name: "Lucas Mendes",
      company: "Tech Solutions",
      date: new Date(2026, 8, 14, 10, 0), // 10am -> Bom dia
    });

    expect(rendered).toBe("Bom dia, Lucas! Aqui é da Tech Solutions.");
  });
});
