import { describe, it, expect } from "vitest";
import { isCommand, parseCommand } from "./commands";

describe("commands", () => {
  it("recognizes commands and the // escape", () => {
    expect(isCommand("/help")).toBe(true);
    expect(isCommand("//not a command")).toBe(false);
    expect(isCommand("hi /there")).toBe(false);
  });

  it("parses join with an optional multi-word password", () => {
    expect(parseCommand("/join #ops")).toEqual({ cmd: "join", room: "#ops", password: undefined });
    expect(parseCommand("/j #ops two words")).toEqual({ cmd: "join", room: "#ops", password: "two words" });
  });

  it("parses msg, nick, aliases and rejects bad input", () => {
    expect(parseCommand("/m ana hey there")).toEqual({ cmd: "msg", target: "ana", text: "hey there" });
    expect(parseCommand("/nick ana_1")).toEqual({ cmd: "nick", name: "ana_1" });
    expect(parseCommand("/nick <script>").cmd).toBe("error");
    expect(parseCommand("/part").cmd).toBe("leave");
    expect(parseCommand("/nope").cmd).toBe("error");
  });
});
