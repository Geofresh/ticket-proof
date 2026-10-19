import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProject, loadTickets, expectedFor } from "../src/project.js";
import { CachedProvider } from "../src/providers/index.js";
import { evaluateTicket, runTickets, summarize } from "../src/run.js";

const dir = path.join(__dirname, "..", "examples", "acmecloud");

describe("acmecloud example", async () => {
  const { project } = await loadProject(dir);
  const tickets = loadTickets(path.join(dir, "tickets.json"));

  it("ships about 50 tickets and exactly one cached response each", () => {
    expect(tickets.length).toBe(50);
    expect(fs.readdirSync(path.join(dir, "cache")).filter((name) => name.endsWith(".json"))).toHaveLength(tickets.length);
  });

  it("scores every ticket from the cache with no key and no calls", async () => {
    const cache = new CachedProvider("openrouter-decisions", "~typesafe/jev-latest", path.join(dir, "cache"), null);
    for (const variant of [project.policy, project.variants!["model-only"]!]) {
      const { scored, failures } = await runTickets(tickets, (ticket) => evaluateTicket(project, ticket, cache, variant));
      expect(failures).toEqual([]);
      expect(scored).toHaveLength(50);
      expect(summarize(project, scored).cases).toBe(50);
    }
    expect(cache.misses).toBe(0);
  });

  it("every expected decision comes from the facts hook, and every error code has a weight", () => {
    for (const ticket of tickets) {
      expect(ticket.expected).toBeUndefined();
      const expected = expectedFor(project, ticket);
      expect(Object.keys(expected).sort()).toEqual(
        ["engineering_candidate", "human_required", "intent", "refund_eligible", "safe_to_automate", "security", "spam", "urgency", "workflow"].sort(),
      );
    }
  });
});
