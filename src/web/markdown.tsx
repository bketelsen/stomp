import DOMPurify from "dompurify";
import { Marked } from "marked";
import { memo, useMemo } from "react";

const marked = new Marked({ gfm: true, breaks: false });

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
	if (node.tagName === "A") {
		node.setAttribute("target", "_blank");
		node.setAttribute("rel", "noreferrer noopener");
	}
});

/** Assistant text as sanitized markdown. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
	const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false })), [text]);
	return <div className="md min-w-0 break-words" dangerouslySetInnerHTML={{ __html: html }} />;
});
