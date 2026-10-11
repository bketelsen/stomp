// The wiki: `#/wiki/<path>` shows a page read from the checkout on each visit, with the page list by folder beside it
// (above it, folded, on a phone) and a link to the file on GitHub. Read-only: the wiki agent edits it.
import { useEffect, useRef, useState } from "react";
import type { WikiEntry, WikiView } from "../shared/protocol.ts";
import { Html } from "./markdown.tsx";
import { wikiView } from "./store.ts";
import { wikiHref } from "./view.ts";

const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

function Pages({ pages, current }: { pages: WikiEntry[]; current?: string }) {
	const folders = [...new Set(pages.map((page) => folderOf(page.path)))];
	return (
		<div className="flex flex-col gap-3 text-sm">
			{folders.map((folder) => (
				<ul key={folder}>
					{folder && <li className="px-2 pb-1 font-mono text-xs text-muted">{folder}/</li>}
					{pages
						.filter((page) => folderOf(page.path) === folder)
						.map((page) => (
							<li key={page.path}>
								<a
									href={wikiHref(page.path)}
									title={page.path}
									className={`block truncate rounded-md px-2 py-1 max-md:min-h-10 ${page.path === current ? "bg-line text-fg" : "text-muted hover:text-fg"}`}
								>
									{page.title}
								</a>
							</li>
						))}
				</ul>
			))}
		</div>
	);
}

/** `section`: a heading's id to scroll to, or "". */
export function Wiki({ path, section }: { path: string; section: string }) {
	const [view, setView] = useState<WikiView>();
	const [failed, setFailed] = useState<string>();
	const [pagesOpen, setPagesOpen] = useState(false);
	const scroller = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let current = true;
		setPagesOpen(false);
		wikiView(path).then(
			(v) => current && (setView(v), setFailed(undefined)),
			(error: Error) => current && setFailed(`Couldn't load the wiki: ${error.message}`),
		);
		return () => {
			current = false;
		};
	}, [path]);
	const page = view?.page;
	// A new page starts at its top, or at its section once it's rendered.
	useEffect(() => {
		const heading = section ? document.getElementById(section) : null;
		if (heading) heading.scrollIntoView({ block: "start" });
		else scroller.current?.scrollTo(0, 0);
	}, [page?.path, page?.html, section]);
	return (
		<div className="flex min-h-0 flex-1">
			<nav className="w-60 shrink-0 overflow-y-auto border-r border-line px-2 py-4 max-md:hidden">{view && <Pages pages={view.pages} current={page?.path} />}</nav>
			<div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-3xl flex-col gap-3 px-3 py-4 md:px-6">
					<div className="flex items-center gap-3 text-xs text-muted">
						<span className="min-w-0 flex-1 truncate font-mono">{view ? `${view.repo}${page ? ` · ${page.path}` : ""}` : "wiki"}</span>
						<button type="button" onClick={() => setPagesOpen(!pagesOpen)} className="min-h-10 shrink-0 hover:text-fg md:hidden">
							pages
						</button>
						{page && (
							<a href={page.github} target="_blank" rel="noreferrer noopener" className="shrink-0 hover:text-fg max-md:min-h-10 max-md:leading-10">
								GitHub ↗
							</a>
						)}
					</div>
					{pagesOpen && view && (
						<div className="rounded-lg border border-line bg-panel p-2 md:hidden">
							<Pages pages={view.pages} current={page?.path} />
						</div>
					)}
					{view?.notice && <p className="rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">{view.notice}</p>}
					{failed && <p className="text-sm text-err">{failed}</p>}
					{view === undefined && !failed && <p className="text-sm text-muted">Loading…</p>}
					{view && !page && <p className="text-sm text-muted">No page at {path || "the top"}.</p>}
					{page && <Html html={page.html} />}
				</div>
			</div>
		</div>
	);
}
