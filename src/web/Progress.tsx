// The progress strip above the composer: one line per thing under way on the open thread (ThreadInfo.progress).
import type { Progress } from "../shared/protocol.ts";

/** The activity dot's color per kind; others use the accent. */
const TINT: Record<string, string> = { review: "bg-review" };

export function ProgressStrip({ items }: { items: readonly Progress[] | undefined }) {
	if (!items?.length) return null;
	return (
		<div role="status" className="mb-1.5 flex flex-col gap-1">
			{items.map((item) => (
				<div key={item.id} className="flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm">
					<span aria-hidden className={`size-2 shrink-0 rounded-full motion-safe:animate-pulse ${TINT[item.kind] ?? "bg-accent"}`} />
					<span className="shrink-0">{item.label}</span>
					<span className="min-w-0 truncate text-xs text-muted">{item.detail.join(" · ")}</span>
				</div>
			))}
		</div>
	);
}
