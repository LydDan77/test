// A small XML reader for the feeds this app consumes: RSS and Atom news feeds, the State
// Department advisory feed and the FAA airport status document.
//
// There is no XML package among the app's dependencies, and these documents are plain: elements,
// attributes, text, CDATA. So this reads exactly that, strictly enough that an HTML error page
// fails instead of half-parsing, and safely: no DTD processing, no entity expansion beyond the
// five XML entities and character references, a depth limit and a node limit.
//
// Pure. Throws XmlError for anything that is not well-formed.

export type XmlElement = {
  /** The name exactly as written, prefix included: "item", "dc:date", "atom:link". */
  name: string;
  attributes: Record<string, string>;
  /** Child elements in document order. */
  children: XmlElement[];
  /** This element's own text and CDATA joined together (not its descendants'), entities decoded. */
  text: string;
};

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlError";
  }
}

const MAX_DEPTH = 100;
const MAX_ELEMENTS = 200_000;
const NAME_PATTERN = /^[A-Za-z_][\w.:-]*$/;

/** Parses a whole document and returns its root element. Throws XmlError when it is not well-formed. */
export function parseXml(source: string): XmlElement {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const length = text.length;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let elements = 0;
  let i = 0;

  const fail = (message: string): never => {
    throw new XmlError(`${message} (at character ${i})`);
  };

  const addText = (raw: string, decode: boolean) => {
    const top = stack[stack.length - 1];
    if (!top) {
      if (raw.trim() !== "") fail("Text outside the root element");
      return;
    }
    top.text += decode ? decodeXmlEntities(raw) : raw;
  };

  while (i < length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) {
      addText(text.slice(i), true);
      break;
    }
    if (lt > i) addText(text.slice(i, lt), true);
    i = lt;

    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end === -1) fail("Comment is not closed");
      i = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", i)) {
      const end = text.indexOf("]]>", i + 9);
      if (end === -1) fail("CDATA section is not closed");
      if (stack.length === 0) fail("CDATA outside the root element");
      addText(text.slice(i + 9, end), false);
      i = end + 3;
      continue;
    }
    if (text.startsWith("<?", i)) {
      const end = text.indexOf("?>", i + 2);
      if (end === -1) fail("Processing instruction is not closed");
      i = end + 2;
      continue;
    }
    if (text.startsWith("<!", i)) {
      // <!DOCTYPE …>, possibly with an internal subset in [ ]. Skipped, never processed.
      let depth = 0;
      let j = i + 2;
      for (; j < length; j++) {
        const ch = text[j];
        if (ch === "[") depth++;
        else if (ch === "]") depth--;
        else if (ch === ">" && depth <= 0) break;
      }
      if (j >= length) fail("Declaration is not closed");
      i = j + 1;
      continue;
    }

    if (text[i + 1] === "/") {
      const end = text.indexOf(">", i + 2);
      if (end === -1) fail("Closing tag is not closed");
      const name = text.slice(i + 2, end).trim();
      const top = stack.pop();
      if (!top) return fail(`Closing tag </${name}> has no opening tag`);
      if (top.name !== name) fail(`Expected </${top.name}> but found </${name}>`);
      i = end + 1;
      continue;
    }

    // An opening tag.
    if (root && stack.length === 0) fail("More than one root element");
    let j = i + 1;
    while (j < length && !/[\s/>]/.test(text[j])) j++;
    const name = text.slice(i + 1, j);
    if (!NAME_PATTERN.test(name)) fail(`Not an element name: "${name.slice(0, 40)}"`);

    const element: XmlElement = { name, attributes: {}, children: [], text: "" };
    let selfClosing = false;
    for (;;) {
      while (j < length && /\s/.test(text[j])) j++;
      if (j >= length) fail(`Tag <${name}> is not closed`);
      if (text[j] === ">") {
        j++;
        break;
      }
      if (text[j] === "/") {
        if (text[j + 1] !== ">") fail(`Unexpected "/" in <${name}>`);
        selfClosing = true;
        j += 2;
        break;
      }
      let k = j;
      while (k < length && !/[\s=/>]/.test(text[k])) k++;
      const attribute = text.slice(j, k);
      if (!NAME_PATTERN.test(attribute)) fail(`Not an attribute name in <${name}>`);
      while (k < length && /\s/.test(text[k])) k++;
      if (text[k] !== "=") fail(`Attribute ${attribute} in <${name}> has no value`);
      k++;
      while (k < length && /\s/.test(text[k])) k++;
      const quote = text[k];
      if (quote !== '"' && quote !== "'") fail(`Attribute ${attribute} in <${name}> is not quoted`);
      const close = text.indexOf(quote, k + 1);
      if (close === -1) fail(`Attribute ${attribute} in <${name}> is not closed`);
      element.attributes[attribute] = decodeXmlEntities(text.slice(k + 1, close));
      j = close + 1;
    }

    if (++elements > MAX_ELEMENTS) fail("Too many elements");
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else root = element;
    if (!selfClosing) {
      stack.push(element);
      if (stack.length > MAX_DEPTH) fail("Elements are nested too deeply");
    }
    i = j;
  }

  if (stack.length > 0) {
    i = length;
    fail(`<${stack[stack.length - 1].name}> is never closed`);
  }
  if (!root) {
    i = 0;
    return fail("No root element");
  }
  return root;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** The handful of HTML names that turn up inside feed text. Anything else is left as written. */
const HTML_ENTITIES: Record<string, string> = {
  ...XML_ENTITIES,
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  eacute: "é",
  egrave: "è",
  aacute: "á",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  ccedil: "ç",
  atilde: "ã",
  ocirc: "ô",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  copy: "©",
  reg: "®",
  trade: "™",
};

function decodeWith(table: Record<string, string>, value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,15});/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    return table[body] ?? whole;
  });
}

/** `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;` and numeric references. Unknown names stay as written. */
export function decodeXmlEntities(value: string): string {
  return decodeWith(XML_ENTITIES, value);
}

/**
 * Text that may hold HTML (a feed title, an advisory summary) as one line of plain text:
 * tags removed, entities decoded, white space collapsed.
 */
export function plainText(htmlish: string): string {
  const withoutTags = htmlish.replace(/<[^>]*>/g, " ");
  return decodeWith(HTML_ENTITIES, withoutTags).replace(/[\s\u00a0]+/g, " ").trim();
}

/** Direct children with this name. */
export function childrenNamed(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

/** The first direct child with this name. */
export function firstChild(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((child) => child.name === name);
}

/** The trimmed text of the first direct child with this name; null when it is missing or empty. */
export function childText(element: XmlElement, name: string): string | null {
  const text = firstChild(element, name)?.text.trim();
  return text ? text : null;
}

/** Every element with this name anywhere below `element`, in document order. */
export function descendantsNamed(element: XmlElement, name: string): XmlElement[] {
  const found: XmlElement[] = [];
  const queue: XmlElement[] = [...element.children].reverse();
  while (queue.length > 0) {
    const next = queue.pop() as XmlElement;
    if (next.name === name) found.push(next);
    for (let index = next.children.length - 1; index >= 0; index--) queue.push(next.children[index]);
  }
  return found;
}
