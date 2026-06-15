import { describe, expect, test } from "vitest";
import { classifyWindowLabel, redactTitle } from "../src/redact.js";

describe("classifyWindowLabel", () => {
  test("maps activity class to a privacy-safe label", () => {
    expect(classifyWindowLabel("coding")).toBe("code editor");
    expect(classifyWindowLabel("designing")).toBe("design file");
    expect(classifyWindowLabel("browsing")).toBe("browser");
  });

  test("sensitive titles override to a guarded label", () => {
    expect(classifyWindowLabel("browsing", "Chase — Account Summary")).toBe("banking");
    expect(classifyWindowLabel("coding", "1Password — Secrets")).toBe("credentials");
  });

  test("unknown activity falls back to unknown", () => {
    expect(classifyWindowLabel("unknown")).toBe("unknown");
  });
});

describe("redactTitle", () => {
  test("strips emails, urls, and long number runs", () => {
    expect(redactTitle("draft to a.b+x@example.com")).toContain("[email]");
    expect(redactTitle("open https://bank.example.com/acct")).toContain("[url]");
    expect(redactTitle("card 4242 4242 4242 4242")).toContain("[number]");
  });

  test("leaves ordinary titles intact", () => {
    expect(redactTitle("checkout-flow-v3")).toBe("checkout-flow-v3");
  });
});
