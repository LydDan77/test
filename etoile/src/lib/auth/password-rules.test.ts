import { describe, expect, it } from "vitest";
import { passwordProblem } from "./password-rules";

const TOO_EASY = "That password is too easy to guess. Try a few words together";
const OWN = "Do not use your own name or email address as the password";

describe("passwordProblem", () => {
  it("accepts ordinary long passwords, with no rule about symbols or mixes", () => {
    for (const fine of [
      "correct horse battery staple", // every test account's password
      "another long password",
      "old password!",
      "lake butler house",
      "Tr0ub4dor&3xyz",
      "ilikepancakesonsunday",
      "fjord-waltz-quick-2026",
      "пароль-подлиннее-один",
      "contraseña larga y rara",
      "x".repeat(4) + "y".repeat(3) + "zw9", // ten characters, five different ones
    ]) {
      expect(passwordProblem(fine, { email: "lydia@example.com", name: "Lydia Hartley" }), fine).toBeNull();
    }
  });

  it("keeps the length rule first", () => {
    expect(passwordProblem("short")).toBe("Use at least 10 characters");
    expect(passwordProblem("")).toBe("Use at least 10 characters");
    expect(passwordProblem("a".repeat(257))).toBe("Use a shorter password");
  });

  it("refuses the passwords everybody tries first", () => {
    for (const easy of [
      "1234567890", "qwertyuiop", "QWERTYUIOP", "password123", "Password123", "PASSWORD1234", "passwordpassword", "1q2w3e4r5t",
      "iloveyou123", "abcdefghij", "0987654321", "letmein123", "welcome123", "admin12345", "1qaz2wsx3edc",
      "Password2026!", "password!!!!", "qwerty!!!!123", "Welcome2026", "letmein!!!!",
    ]) {
      expect(passwordProblem(easy), easy).toBe(TOO_EASY);
    }
  });

  it("refuses one character repeated, a few taking turns, a repeated piece, a run of keys and only spaces", () => {
    for (const easy of ["aaaaaaaaaa", "          ", "1111111111", "1212121212", "abababababab", "abcabcabcabc", "hellohello", "3456789012", "ghijklmnop", "asdfghjklasd", "zyxwvutsrq"]) {
      expect(passwordProblem(easy), JSON.stringify(easy)).toBe(TOO_EASY);
    }
  });

  it("refuses the person's own email and name", () => {
    const who = { email: "lydia.hartley@example.com", name: "Lydia Hartley" };
    for (const own of ["lydia.hartley@example.com", "LYDIA.HARTLEY@EXAMPLE.COM", "lydia.hartley", "LydiaHartley", "lydia hartley", "Lydia-Hartley", "lydiahartley1", "lydia.hartley2026"]) {
      expect(passwordProblem(own, who), own).toBe(OWN);
    }
    // Someone else's name is just a password.
    expect(passwordProblem("lydia hartley", { email: "mark@example.com", name: "Mark" })).toBeNull();
    // A password that merely contains the name is allowed.
    expect(passwordProblem("lydia hartley loves pancakes", who)).toBeNull();
    // A very short name or mailbox is not held against anything.
    expect(passwordProblem("ab-is-my-cat", { email: "ab@example.com", name: "Ab" })).toBeNull();
  });
});
