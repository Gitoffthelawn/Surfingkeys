/*
 * Turn a page -- or any node of one -- into Markdown, for an LLM to read.
 *
 * `innerText` is what the eye gets: it keeps the words and throws away everything
 * the words point AT. A link becomes its label with no destination, an image
 * becomes nothing at all however carefully its alt text was written, a form
 * becomes a few stray captions with no hint of what submitting it would do, and a
 * table becomes columns run together into one line. A model asked to "open the
 * first link here" or "what does this form send" cannot answer from that, and
 * worse, cannot tell that the answer was withheld -- so it guesses.
 *
 * Markdown keeps those relationships in the one form a model already reads
 * fluently, at a cost of a few characters each.
 *
 * That has a price of its own: once structure is written in the text, a page can
 * try to write some too. The invariant that answers it is that every bracket in
 * this output is one this file put there -- see `escapeBrackets` -- so a link, an
 * image or a form annotation is always a thing the DOM really contains.
 *
 * Two callers with different constraints: the live page, which has layout, so
 * nodes the reader cannot see are skipped; and a document from `DOMParser` (a page
 * fetched by `fetch_url`), which has no view at all. Nothing here may therefore
 * depend on being able to measure anything, and `baseUrl` is how the second caller
 * supplies what the first gets for free.
 */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const FRAGMENT_NODE = 11;

// Nothing inside these is text the user is reading: it is code, styling, or a
// document of its own that this walk cannot reach into anyway.
const SKIPPED_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "LINK", "META",
    "SVG", "CANVAS", "IFRAME", "FRAME", "OBJECT", "EMBED", "APPLET",
    "AUDIO", "VIDEO", "TRACK", "SOURCE", "MAP", "AREA", "DATALIST",
]);

// Tags with no Markdown of their own that still end the line they are on.
const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BODY", "CENTER", "DETAILS", "DIALOG",
    "DIV", "DL", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "HEADER", "HGROUP",
    "LEGEND", "MAIN", "NAV", "P", "SEARCH", "SECTION",
]);

// How much of one field's value is worth carrying. A textarea can hold an entire
// draft, and it is the shape of the form that is being described here.
const MAX_VALUE_LENGTH = 200;
// A country picker is 200 options that say nothing the name of the field did not.
const MAX_OPTIONS = 20;

/**
 * @param {Node} root the node to convert, typically `document.body`.
 * @param {object} [opts]
 * @param {string} [opts.baseUrl] what relative URLs are resolved against.
 *     Required for a document that was parsed rather than loaded, whose own
 *     `baseURI` is the extension's.
 * @returns {string} Markdown.
 */
export default function toMarkdown(root, opts = {}) {
    if (!root) {
        return "";
    }
    const ctx = {
        hidden: hiddenTest(root),
        baseUrl: opts.baseUrl || "",
    };
    const raw = root.nodeType === FRAGMENT_NODE
        ? childrenOf(root, ctx)
        : convert(root, ctx);
    return tidy(raw);
}

/**
 * The current selection as Markdown, or "" when there is none.
 *
 * The range is CLONED rather than walked in place: the clone belongs to the same
 * document, so its nodes still resolve relative URLs against the page, while the
 * page and the user's selection are left untouched. A partly selected element
 * comes back as that element holding only the selected part, which is what keeps
 * a half-selected link a link.
 *
 * The clone is detached, so nothing in it can be measured and nothing is dropped
 * for being invisible -- unlike a walk of the live page. That is the right way
 * round: what the user selected is by definition what the user could see, and a
 * hidden node caught in the range costs a few words, while dropping a visible one
 * would lose the very text that was picked.
 *
 * @param {Selection} [selection] defaults to the window's.
 * @returns {string} Markdown.
 */
export function selectionToMarkdown(selection) {
    const sel = selection
        || (typeof window !== "undefined" && window.getSelection && window.getSelection());
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        return "";
    }
    let out = "";
    for (let i = 0; i < sel.rangeCount; i++) {
        out += `\n\n${toMarkdown(sel.getRangeAt(i).cloneContents())}`;
    }
    return tidy(out);
}

/*
 * Whether a node is one the reader cannot see.
 *
 * Only answerable where there is layout. A parsed document has no view, so
 * nothing can be measured and the honest answer is to drop nothing -- a page
 * fetched for its text is better read whole than filtered by guesswork.
 *
 * Answers are cached: `getComputedStyle` resolves style for the element, which is
 * the most expensive thing this conversion does, and a list item or a table cell
 * is asked about twice -- once by the container deciding whether to lay it out,
 * once by the walk that converts it.
 */
function hiddenTest(root) {
    const doc = root.ownerDocument || root;
    const view = doc && doc.defaultView;
    if (!view || typeof view.getComputedStyle !== "function") {
        return () => false;
    }
    const seen = new WeakMap();
    return function(el) {
        if (seen.has(el)) {
            return seen.get(el);
        }
        let hidden = true;
        if (!el.hasAttribute("hidden")) {
            // a detached node reports an empty style rather than a computed one, so
            // this says "not hidden" for it, which is the safe direction
            const style = view.getComputedStyle(el);
            hidden = style.display === "none" || style.visibility === "hidden";
        }
        seen.set(el, hidden);
        return hidden;
    };
}

/*
 * Runs of blank lines a layout leaves behind cost as much as words, so they
 * collapse. Nothing else moves: the line structure is load-bearing, since a
 * list's indentation and a code block's whitespace are what say which they are.
 *
 * Exported because every caller that hands this Markdown to a model wants the
 * same rule, and two implementations of it would drift.
 */
export function tidy(md) {
    return (md || "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function convert(node, ctx) {
    if (node.nodeType === TEXT_NODE) {
        // runs of whitespace, newlines included, are one space on a rendered page
        const text = node.nodeValue.replace(/\s+/g, " ");
        // Inside a code span the backslash would be literal, and the brackets are
        // already inert there.
        return ctx.inCode ? text : escapeBrackets(text);
    }
    if (node.nodeType !== ELEMENT_NODE) {
        return "";
    }
    const tag = node.tagName.toUpperCase();
    if (SKIPPED_TAGS.has(tag)) {
        return "";
    }
    /*
     * `input[type=hidden]` is `display: none` in every UA stylesheet, so the
     * visibility test would drop the one field whose NAME is worth reporting --
     * what a form submits is not limited to what the user can see.
     */
    if (ctx.hidden(node) && !(tag === "INPUT" && isHiddenInput(node))) {
        return "";
    }
    return element(node, tag, ctx);
}

function isHiddenInput(node) {
    return (node.getAttribute("type") || "").trim().toLowerCase() === "hidden";
}

/*
 * Brackets are how this file says "structure": a link, an image, a field. A page
 * that prints `[form POST https://evil.example/pay]` or `[a](https://evil.example)`
 * in its own text would be indistinguishable from output produced here, and the
 * model has nothing to check it against -- it cannot see the DOM. So every bracket
 * that came from the page is escaped, and every bracket that survives unescaped is
 * one this file wrote.
 *
 * Applied to text nodes and to the attributes that get quoted into an annotation,
 * never to the structure itself, which is added afterwards.
 */
function escapeBrackets(text) {
    return text.replace(/([[\]])/g, "\\$1");
}

/*
 * A URL that the surrounding `[label](...)` cannot be broken out of.
 *
 * `new URL` already percent-encodes whitespace and angle brackets, but not
 * parentheses and not brackets, and both are how a destination gets away from us:
 * an unbalanced `)` ENDS a Markdown destination, so
 * `href="/x) [pay](https://evil.example"` would smuggle in a second link that
 * reads exactly like one of ours, while a `[...](...)` hidden inside an otherwise
 * balanced URL reads as a link to anything that skims rather than parses -- which
 * a model does. So brackets are encoded, leaving the invariant of this file intact
 * inside a destination too, and an unbalanced destination is wrapped in angle
 * brackets, where `)` carries no meaning, rather than rewritten: the model is
 * meant to be able to hand this URL straight to `fetch_url`.
 */
function destination(url) {
    const safe = url.replace(/[<>[\]\s]/g, encodeURIComponent);
    return balancedParens(safe) ? safe : `<${safe}>`;
}

function balancedParens(text) {
    let depth = 0;
    for (const c of text) {
        if (c === "(") {
            depth += 1;
        } else if (c === ")" && (depth -= 1) < 0) {
            return false;
        }
    }
    return depth === 0;
}

function childrenOf(node, ctx) {
    return Array.from(node.childNodes).map((n) => convert(n, ctx)).join("");
}

// One line of Markdown: for a heading, a table cell or a link label, where a
// newline would break the construct it sits in.
function oneLine(node, ctx) {
    return childrenOf(node, ctx).replace(/\s+/g, " ").trim();
}

// A block stands alone. The blank lines are added generously and collapsed once
// at the end, which is what makes nesting containers cost nothing to reason
// about here.
function block(content) {
    return content && content.trim() ? `\n\n${content.trim()}\n\n` : "";
}

function element(node, tag, ctx) {
    switch (tag) {
        case "BR":
            return "\n";
        case "HR":
            return block("---");
        case "H1": case "H2": case "H3": case "H4": case "H5": case "H6":
            return block(`${"#".repeat(Number(tag[1]))} ${oneLine(node, ctx)}`);
        case "A":
            return link(node, ctx);
        case "IMG":
            return image(node, ctx);
        case "STRONG": case "B":
            return emphasis(childrenOf(node, ctx), "**");
        case "EM": case "I":
            return emphasis(childrenOf(node, ctx), "*");
        case "DEL": case "S": case "STRIKE":
            return emphasis(childrenOf(node, ctx), "~~");
        case "CODE": case "KBD": case "SAMP": case "VAR":
            return code(childrenOf(node, Object.assign({}, ctx, { inCode: true })));
        case "PRE":
            return block(fencedCode(node));
        case "BLOCKQUOTE":
            // tidied before prefixing: the blank lines between the blocks inside
            // are collapsed once here, otherwise each survives as its own `>` line
            return block(prefixLines(tidy(childrenOf(node, ctx)), "> "));
        case "UL": case "OL": case "MENU":
            return block(list(node, tag === "OL", ctx));
        case "LI":
            // reached only for an <li> that is not inside a list; treat it as one
            return block(`- ${childrenOf(node, ctx).trim()}`);
        case "DT":
            return block(`**${oneLine(node, ctx)}**`);
        case "DD":
            // marked as the definition of the term above it: as its own paragraph
            // it would read as the next sentence of the page, and which <dt> it
            // belongs to is the whole content of a definition list
            return block(indentRest(`: ${tidy(childrenOf(node, ctx))}`, "  "));
        case "TABLE":
            return block(table(node, ctx));
        case "SUMMARY":
            return block(`**${oneLine(node, ctx)}**`);
        case "FORM":
            return form(node, ctx);
        case "INPUT":
            return block(input(node, ctx));
        case "TEXTAREA":
            return block(textarea(node, ctx));
        case "SELECT":
            return block(select(node, ctx));
        case "BUTTON":
            return block(button(node, ctx));
        case "OPTION": case "OPTGROUP":
            // listed by their <select>; on their own they are not content
            return "";
        default:
            return BLOCK_TAGS.has(tag)
                ? block(childrenOf(node, ctx))
                : childrenOf(node, ctx);
    }
}

/*
 * Markdown emphasis cannot span the space next to its marker, and an element
 * whose text is only whitespace would otherwise produce `** **`.
 */
function emphasis(text, marker) {
    const trimmed = text.trim();
    if (!trimmed) {
        return text ? " " : "";
    }
    const lead = /^\s/.test(text) ? " " : "";
    const tail = /\s$/.test(text) ? " " : "";
    return `${lead}${marker}${trimmed}${marker}${tail}`;
}

function code(text) {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!trimmed) {
        return "";
    }
    // a backtick inside needs a longer fence than anything it contains
    const fence = "`".repeat(longestRun(trimmed, "`") + 1);
    const pad = trimmed.startsWith("`") || trimmed.endsWith("`") ? " " : "";
    return `${fence}${pad}${trimmed}${pad}${fence}`;
}

function longestRun(text, char) {
    let best = 0;
    let run = 0;
    for (const c of text) {
        run = c === char ? run + 1 : 0;
        best = Math.max(best, run);
    }
    return best;
}

/*
 * `textContent`, not a walk: inside a code block the whitespace IS the content,
 * and a link or a highlighting <span> in there is decoration over text the reader
 * wants exactly as written.
 */
function fencedCode(node) {
    const text = node.textContent.replace(/\n+$/, "");
    if (!text.trim()) {
        return "";
    }
    const cls = node.getAttribute("class") || "";
    const lang = (cls.match(/(?:language|lang|highlight)-([\w+#-]+)/) || [])[1] || "";
    const fence = "`".repeat(Math.max(3, longestRun(text, "`") + 1));
    return `${fence}${lang}\n${text}\n${fence}`;
}

function prefixLines(text, prefix) {
    return text.split("\n").map((l) => `${prefix}${l}`).join("\n");
}

// Every line after the first, so a marker stays hanging over its own item.
function indentRest(text, indent) {
    return text.split("\n").map((l, i) => (i === 0 ? l : `${indent}${l}`)).join("\n");
}

function absolute(url, ctx, node) {
    if (!url) {
        return "";
    }
    try {
        return new URL(url, ctx.baseUrl || node.baseURI || undefined).href;
    } catch (e) {
        // a scheme this browser does not know, or no base to resolve against
        return url;
    }
}

/*
 * `[label](url)`. A link that goes nowhere -- `href="#"`, a `javascript:` handler,
 * no href at all -- is left as its text: naming it a link would tell the model it
 * can follow something it cannot.
 */
function link(node, ctx) {
    const text = oneLine(node, ctx);
    const href = (node.getAttribute("href") || "").trim();
    if (!href || href === "#" || /^javascript:/i.test(href)) {
        return text;
    }
    const url = destination(shorten(absolute(href, ctx, node)));
    if (text) {
        return `[${text}](${url})`;
    }
    // an icon link: whatever the page named it for a screen reader
    const label = node.getAttribute("aria-label") || node.getAttribute("title") || "";
    return label ? `[${escapeBrackets(label.trim())}](${url})` : `<${url}>`;
}

/*
 * `alt=""` is the page saying this image carries nothing -- a spacer, a bullet, a
 * gradient -- so it is dropped, which is the whole reason the attribute is
 * allowed to be empty.
 *
 * An image whose source cannot be worked out still keeps its `![...]` marker: the
 * model is then told there is a picture here it cannot fetch, rather than handed
 * the alt text as if the page had written it as prose.
 */
function image(node, ctx) {
    const alt = (node.getAttribute("alt") || "").replace(/\s+/g, " ").trim();
    if (node.hasAttribute("alt") && !alt) {
        return "";
    }
    const src = imageSource(node);
    const label = (alt || node.getAttribute("title") || node.getAttribute("aria-label") || "").trim();
    if (!src && !label) {
        // nothing to report: no source to fetch and no word about what it showed
        return "";
    }
    const url = src ? destination(shorten(absolute(src, ctx, node))) : "";
    return `![${escapeBrackets(label)}](${url})`;
}

/*
 * A responsive image names its candidates in `srcset` and may carry no `src` at
 * all, so the first candidate stands in for it -- which one the browser would
 * pick depends on a viewport this conversion has no opinion about.
 */
function imageSource(node) {
    const src = (node.getAttribute("src") || node.getAttribute("data-src") || "").trim();
    if (src) {
        return src;
    }
    const srcset = (node.getAttribute("srcset") || node.getAttribute("data-srcset") || "").trim();
    // "a.png 1x, b.png 2x" -- the URL is the first word of the first candidate
    return srcset.split(",")[0].trim().split(/\s+/)[0] || "";
}

/*
 * A `data:` URL is the resource itself, not a reference to it -- inlining one
 * would spend the whole budget of the answer on a base64 image.
 */
function shorten(url) {
    return /^data:/i.test(url) ? `${url.slice(0, url.indexOf(",") + 1) || "data:"}...` : url;
}

function list(node, ordered, ctx) {
    let start = parseInt(node.getAttribute("start"), 10);
    if (!Number.isFinite(start)) {
        start = 1;
    }
    const lines = [];
    let index = 0;
    let indent = "";
    Array.from(node.children).forEach((child) => {
        if (ctx.hidden(child)) {
            return;
        }
        if (child.tagName === "LI") {
            const marker = ordered ? `${start + index}. ` : "- ";
            index += 1;
            indent = " ".repeat(marker.length);
            // a blank line inside an item would end the list, so the blocks nested
            // in it are packed tight instead
            const body = childrenOf(child, ctx).replace(/\n{2,}/g, "\n").trim();
            // an empty item is a marker and nothing else; it still spends its
            // number, the way the browser numbers it, so the items after it do not
            // shift up
            if (body) {
                lines.push(`${marker}${indentRest(body, indent)}`);
            }
            return;
        }
        /*
         * A child that is not an <li>: a nested list written one level up, or the
         * <div> a framework wrapped its items in. Neither is valid, both are
         * common, and a browser lays out all of it -- so taking only the <li>s
         * here would drop that content with nothing left to show it was ever
         * there, up to and including every item of the list.
         *
         * It goes under the item above, which is where the browser draws it too,
         * and stands on its own when the list has not reached an item yet.
         */
        const extra = tidy(convert(child, ctx)).replace(/\n{2,}/g, "\n");
        if (extra) {
            lines.push(indent ? prefixLines(extra, indent) : extra);
        }
    });
    return lines.join("\n");
}

/*
 * This table's own rows, in document order.
 *
 * Walked down through the section elements rather than collected with
 * `querySelectorAll("tr")`: a nested table's rows are never a direct child of a
 * `tr`'s section, so they are excluded by construction instead of by asking each
 * row which table it belongs to -- which read every nested row once per level of
 * nesting.
 */
function tableRows(node) {
    const rows = [];
    (function walk(parent) {
        Array.from(parent.children).forEach((child) => {
            const tag = child.tagName;
            if (tag === "TR") {
                rows.push(child);
            } else if (tag === "THEAD" || tag === "TBODY" || tag === "TFOOT") {
                walk(child);
            }
        });
    }(node));
    return rows;
}

/*
 * A pipe table. Its first row is the header, because Markdown has no way to say
 * a table has none, and a model reading `| --- |` under the first row loses
 * nothing if that row was data.
 *
 * The caption comes first, on its own line: it is regularly the only text that
 * says what the table is OF, and a table has no other place to put it.
 *
 * `colspan`/`rowspan` are not expressed: a merged cell is written once, in its
 * own column, which keeps every row the same width and is the closest a flat
 * table gets to the truth.
 */
function table(node, ctx) {
    const rows = tableRows(node).filter((r) => !ctx.hidden(r));
    const cells = rows
        .map((r) => Array.from(r.children)
            .filter((c) => (c.tagName === "TD" || c.tagName === "TH") && !ctx.hidden(c))
            .map((c) => oneLine(c, ctx).replace(/\|/g, "\\|")))
        .filter((r) => r.length > 0);
    const caption = Array.from(node.children)
        .find((c) => c.tagName === "CAPTION" && !ctx.hidden(c));
    const heading = caption ? `**${oneLine(caption, ctx)}**` : "";
    if (cells.length === 0) {
        return heading;
    }
    const width = Math.max(...cells.map((r) => r.length));
    const row = (cs) => `| ${cs.concat(Array(width - cs.length).fill("")).join(" | ")} |`;
    const grid = [
        row(cells[0]),
        `| ${Array(width).fill("---").join(" | ")} |`,
        ...cells.slice(1).map(row),
    ].join("\n");
    return heading ? `${heading}\n\n${grid}` : grid;
}

/*
 * Where the data goes and by which method, which is what a form is for and what a
 * model must not invent. An action of "" submits back to the page itself.
 */
function form(node, ctx) {
    const action = node.getAttribute("action");
    // this lands in the annotation unquoted, and a browser falls back to GET for
    // anything that is not one of the three methods a form can have
    const method = (node.getAttribute("method") || "").trim().toUpperCase();
    const verb = method === "POST" || method === "DIALOG" ? method : "GET";
    const target = action === null || action.trim() === ""
        ? (ctx.baseUrl || node.baseURI || "this page")
        : absolute(action.trim(), ctx, node);
    return block(`[form ${verb} ${escapeBrackets(target)}]\n\n${childrenOf(node, ctx).trim()}`);
}

/*
 * Fields are described rather than transcribed, one per line, so that the model
 * can see what the form expects. The label is repeated into the annotation even
 * though its text is also in the flow: flat text puts a caption near a field,
 * while this says which field it belongs to.
 */
function input(node, ctx) {
    const type = (node.getAttribute("type") || "text").trim().toLowerCase();
    const name = node.getAttribute("name") || "";
    if (type === "hidden") {
        /*
         * The name is the useful part: it says what the form carries. The value is
         * routinely a CSRF token, a session blob or a serialised view state -- and
         * this text is on its way to a third-party provider, so it stays here.
         */
        return name ? `[hidden field ${escapeBrackets(name.replace(/\s+/g, " ").trim())}]` : "";
    }
    const bits = [inputKind(type)];
    if (name) {
        bits.push(labelled("name", name));
    }
    describeLabel(node, bits);
    if (type === "checkbox" || type === "radio") {
        bits.push(node.checked ? "checked" : "unchecked");
        if (node.value && node.value !== "on") {
            bits.push(quoted("value", node.value));
        }
    } else if (type === "submit" || type === "button" || type === "reset" || type === "image") {
        // an image button's picture is its caption, and its src is what the user
        // would be clicking
        const caption = node.value || node.getAttribute("alt") || "";
        if (caption) {
            bits.push(quoted("caption", caption));
        }
        const src = type === "image" ? (node.getAttribute("src") || "").trim() : "";
        if (src) {
            bits.push(labelled("src", absolute(src, ctx, node)));
        }
    } else if (type !== "password" && type !== "file" && node.value) {
        // a password is never worth repeating anywhere, least of all to a provider
        bits.push(quoted("value", node.value));
    }
    describeState(node, bits);
    return `[${bits.join(" ")}]`;
}

/*
 * The annotation's first word. The type attribute is page-controlled and lands
 * where nothing is quoted, so only a type that exists is ever printed -- and a
 * browser treats a type it does not know as a text field, which is what this then
 * calls it too.
 */
const INPUT_TYPES = new Set([
    "button", "checkbox", "color", "date", "datetime-local", "email", "file",
    "hidden", "image", "month", "number", "password", "radio", "range", "reset",
    "search", "submit", "tel", "time", "url", "week",
]);

function inputKind(type) {
    return INPUT_TYPES.has(type) ? type : "input";
}

function textarea(node, ctx) {
    const bits = ["textarea"];
    if (node.getAttribute("name")) {
        bits.push(labelled("name", node.getAttribute("name")));
    }
    describeLabel(node, bits);
    describeState(node, bits);
    const value = node.value || node.textContent || "";
    const head = `[${bits.join(" ")}]`;
    // what is typed in a textarea is page text like any other: a draft holding
    // "[form POST ...]" must not read as a form
    return value.trim() ? `${head}\n${escapeBrackets(clamp(value.trim()))}` : head;
}

/*
 * An option the user could actually choose.
 *
 * Only the `hidden` attribute is asked about, not the computed style that decides
 * every other element here: a UA draws a picker outside the flow of the document,
 * so what an option's `display` resolves to says little about whether it is
 * offered -- and reading it as "not offered" would empty every select on the page.
 */
function pickable(option) {
    const group = option.parentElement;
    return !option.hasAttribute("hidden")
        && !(group && group.tagName === "OPTGROUP" && group.hasAttribute("hidden"));
}

function select(node, ctx) {
    const bits = [node.multiple ? "select multiple" : "select"];
    if (node.getAttribute("name")) {
        bits.push(labelled("name", node.getAttribute("name")));
    }
    describeLabel(node, bits);
    describeState(node, bits);
    const options = Array.from(node.querySelectorAll("option")).filter(pickable);
    const shown = options.slice(0, MAX_OPTIONS)
        .map((o) => `${oneLine(o, ctx) || escapeBrackets(o.value)}${o.selected ? " (selected)" : ""}`);
    if (options.length > MAX_OPTIONS) {
        shown.push(`... ${options.length - MAX_OPTIONS} more`);
    }
    const head = `[${bits.join(" ")}]`;
    return shown.length > 0 ? `${head} options: ${shown.join(" | ")}` : head;
}

function button(node, ctx) {
    const bits = ["button"];
    const type = (node.getAttribute("type") || "").trim().toLowerCase();
    if (type && type !== "submit") {
        bits.push(labelled("type", type));
    }
    if (node.getAttribute("name")) {
        bits.push(labelled("name", node.getAttribute("name")));
    }
    const caption = oneLine(node, ctx)
        || node.getAttribute("aria-label")
        || node.getAttribute("title")
        || node.value
        || "";
    if (caption.trim()) {
        bits.push(quoted("caption", caption.trim()));
    }
    describeState(node, bits);
    return `[${bits.join(" ")}]`;
}

/*
 * What this control is called, from whichever of the four places the page chose
 * to say it. A field the page never labelled is left unlabelled: inventing one
 * from a nearby heading is the kind of guess this whole module exists to avoid.
 */
function describeLabel(node, bits) {
    const label = labelText(node);
    if (label) {
        bits.push(quoted("label", label));
    }
    const placeholder = node.getAttribute && node.getAttribute("placeholder");
    if (placeholder && placeholder.trim()) {
        bits.push(quoted("placeholder", placeholder.trim()));
    }
}

function labelText(node) {
    const aria = node.getAttribute("aria-label");
    if (aria && aria.trim()) {
        return aria.trim();
    }
    const labels = node.labels && node.labels.length > 0 ? node.labels : null;
    const own = labels ? labels[0] : (node.closest && node.closest("label"));
    const text = own ? own.textContent : (node.getAttribute("title") || "");
    return (text || "").replace(/\s+/g, " ").trim();
}

function describeState(node, bits) {
    if (node.required) {
        bits.push("required");
    }
    if (node.disabled) {
        bits.push("disabled");
    }
    if (node.readOnly) {
        bits.push("readonly");
    }
}

function quoted(key, value) {
    const text = clamp(String(value).replace(/\s+/g, " ").replace(/"/g, "'"));
    // the annotation's own brackets are structure, so a value carrying one is
    // escaped: otherwise it would end the annotation and whatever followed it
    // would read as another field of the form
    return `${key}="${escapeBrackets(text)}"`;
}

/*
 * `key=value` while the value is one plain word, `key="value"` as soon as it is
 * not. `name` and `type` come from the page, and one holding a space, a bracket or
 * a URL would otherwise read as further fields of the annotation.
 */
function labelled(key, value) {
    const text = String(value).replace(/\s+/g, " ").trim();
    return /^[\w.:-]+$/.test(text) ? `${key}=${text}` : quoted(key, text);
}

function clamp(text) {
    return text.length > MAX_VALUE_LENGTH
        ? `${text.slice(0, MAX_VALUE_LENGTH)}...`
        : text;
}
