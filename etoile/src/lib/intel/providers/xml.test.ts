import { describe, expect, it } from "vitest";
import { fixture } from "./test-support";
import { childText, childrenNamed, decodeXmlEntities, descendantsNamed, firstChild, parseXml, plainText, XmlError } from "./xml";

describe("parseXml", () => {
  it("reads elements, attributes, text and nesting", () => {
    const root = parseXml(`<a id="1" kind='x'><b>one</b><b>two</b><c/><d key="v" /></a>`);
    expect(root.name).toBe("a");
    expect(root.attributes).toEqual({ id: "1", kind: "x" });
    expect(root.children.map((child) => child.name)).toEqual(["b", "b", "c", "d"]);
    expect(childrenNamed(root, "b").map((child) => child.text)).toEqual(["one", "two"]);
    expect(firstChild(root, "d")?.attributes).toEqual({ key: "v" });
    expect(firstChild(root, "missing")).toBeUndefined();
  });

  it("keeps prefixed names as written", () => {
    const root = parseXml(`<rss xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:date>2026-11-26T00:06:02Z</dc:date><atom:link href="https://example.org/feed" rel="self"/></rss>`);
    expect(childText(root, "dc:date")).toBe("2026-11-26T00:06:02Z");
    expect(firstChild(root, "atom:link")?.attributes.href).toBe("https://example.org/feed");
  });

  it("skips the declaration, comments, processing instructions and a doctype", () => {
    const root = parseXml(
      `\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<!-- a comment with <tags> in it -->\n<!DOCTYPE note [ <!ELEMENT note (#PCDATA)> ]>\n<?style sheet?>\n<note>hi<!-- inside --> there</note>\n<!-- after -->\n`,
    );
    expect(root.name).toBe("note");
    expect(root.text).toBe("hi there");
  });

  it("takes CDATA as it is and decodes entities everywhere else", () => {
    const root = parseXml(`<t a="x &amp; y &#233;"><![CDATA[<p>in <b>Finland</b> & more</p>]]> &lt;ok&gt; &#x2019; &quot;q&quot; &apos;s&apos;</t>`);
    expect(root.attributes.a).toBe("x & y é");
    expect(root.text).toBe(`<p>in <b>Finland</b> & more</p> <ok> ’ "q" 's'`);
  });

  it("leaves unknown or impossible entities as written, and never expands a declared one", () => {
    expect(decodeXmlEntities("&nbsp; &bogus; &#0; &#xD800; &#99999999; & alone")).toBe("&nbsp; &bogus; &#0; &#xD800; &#99999999; & alone");
    const root = parseXml(`<!DOCTYPE r [ <!ENTITY big "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"> ]><r>&big;&big;&big;</r>`);
    expect(root.text).toBe("&big;&big;&big;");
  });

  it("gives an element's own text, not its descendants'", () => {
    const root = parseXml(`<a>one<b>inner</b>two</a>`);
    expect(root.text).toBe("onetwo");
    expect(childText(root, "b")).toBe("inner");
    expect(childText(root, "nothing")).toBeNull();
    expect(childText(parseXml(`<a><b>   </b></a>`), "b")).toBeNull();
  });

  it("finds descendants in document order", () => {
    const root = parseXml(`<r><x n="1"><x n="2"/></x><y><x n="3"/></y><x n="4"/></r>`);
    expect(descendantsNamed(root, "x").map((element) => element.attributes.n)).toEqual(["1", "2", "3", "4"]);
  });

  it("reads the real FAA status document", () => {
    const root = parseXml(fixture("faa-airport-status-information.xml"));
    expect(root.name).toBe("AIRPORT_STATUS_INFORMATION");
    expect(childText(root, "Update_Time")).toBe("Thu Nov 26 00:06:59 2026 GMT");
    const blocks = childrenNamed(root, "Delay_type");
    expect(blocks.map((block) => childText(block, "Name"))).toEqual(["General Arrival/Departure Delay Info", "Airport Closures"]);
    const delays = descendantsNamed(root, "Delay");
    expect(delays.map((delay) => childText(delay, "ARPT"))).toEqual(["FLL", "MIA"]);
    expect(firstChild(delays[0], "Arrival_Departure")?.attributes.Type).toBe("Departure");
  });

  it("reads every real news and advisory feed", () => {
    const counts = Object.fromEntries(
      ["npr-top.xml", "bbc-news.xml", "skift.xml", "cdc-notices.xml", "state-advisories.trimmed.xml"].map((name) => {
        const root = parseXml(fixture(name));
        expect(root.name).toBe("rss");
        return [name, descendantsNamed(root, "item").length];
      }),
    );
    expect(counts).toEqual({ "npr-top.xml": 10, "bbc-news.xml": 29, "skift.xml": 10, "cdc-notices.xml": 25, "state-advisories.trimmed.xml": 20 });
  });

  it("reads a document that starts with a comment (the reconstructed FAA fixtures do)", () => {
    expect(parseXml(fixture("faa-airport-status-information.no-delays.reconstructed.xml")).children.map((child) => child.name)).toEqual(["Update_Time", "Dtd_File"]);
  });

  it("refuses the HTML error pages these sources really serve", () => {
    for (const name of ["nws-error-no-user-agent.html", "npr-error-403.html", "google-news-blocked-503.html"]) {
      expect(() => parseXml(fixture(name)), name).toThrow(XmlError);
    }
  });

  it.each([
    ["nothing at all", ""],
    ["only white space", "  \n "],
    ["plain text", "Service unavailable"],
    ["an unclosed element", "<a><b>text</b>"],
    ["a mismatched closing tag", "<a><b>text</a></b>"],
    ["a closing tag with no opening", "</a>"],
    ["two roots", "<a/><b/>"],
    ["text after the root", "<a/>trailing"],
    ["an unquoted attribute", "<a id=1/>"],
    ["an attribute with no value", "<a id/>"],
    ["an attribute that never closes", `<a id="1/>`],
    ["an unclosed comment", "<a><!-- never"],
    ["an unclosed CDATA section", "<a><![CDATA[never</a>"],
    ["an unclosed processing instruction", "<?xml version='1.0'"],
    ["a tag cut off mid-way", "<a><b"],
    ["a truncated feed", `<rss><channel><item><title>Half a headl`],
    ["a name that is not a name", "<1a/>"],
    ["JSON", `{"error":true}`],
  ])("throws XmlError for %s", (_label, source) => {
    expect(() => parseXml(source)).toThrow(XmlError);
  });

  it("refuses absurd nesting instead of running out of memory", () => {
    expect(() => parseXml("<a>".repeat(500) + "</a>".repeat(500))).toThrow(/nested too deeply/);
    expect(parseXml("<a>".repeat(50) + "</a>".repeat(50)).name).toBe("a");
  });
});

describe("plainText", () => {
  it("turns HTML-ish text into one plain line", () => {
    expect(plainText("Exercise normal precaution<p>in <b>Finland</b>.</p>")).toBe("Exercise normal precaution in Finland .");
    expect(plainText("to&nbsp;<b>Guyana </b>due to <b>crime</b>")).toBe("to Guyana due to crime");
    expect(plainText("  Leonardo&#8217;s  UK\n Loss ")).toBe("Leonardo’s UK Loss");
    expect(plainText("Fish &amp; chips &ndash; &eacute;t&eacute; &unknown;")).toBe("Fish & chips – été &unknown;");
    expect(plainText("")).toBe("");
  });
});
