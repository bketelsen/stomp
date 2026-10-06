// Cross-family review: the verdict badge and the card a finished review leaves in the author's thread.
import type { ReviewFinding, ReviewRecord } from "../shared/protocol.ts";
import { modelLabel } from "./view.ts";

const VERDICT: Record<ReviewRecord["verdict"], [label: string, style: string]> = {
	approved: ["approved", "bg-ok/10 text-ok"],
	changes_requested: ["changes requested", "bg-warn/10 text-warn"],
	failed: ["review failed", "bg-line text-muted"],
};

export const verdictLabel = (review: ReviewRecord) => VERDICT[review.verdict]?.[0] ?? review.verdict;

/** The verdict as a small badge, titled with the reviewer. With `onClick` it's a button. */
export function Verdict({ review, onClick }: { review: ReviewRecord; onClick?: () => void }) {
	const props = {
		title: `reviewed by ${modelLabel(review.reviewer)} (${review.family})`,
		className: `shrink-0 rounded-full px-2 text-xs leading-5 font-medium whitespace-nowrap ${VERDICT[review.verdict]?.[1] ?? "bg-line text-muted"}`,
		children: verdictLabel(review),
	};
	return onClick ? <button type="button" onClick={onClick} {...props} /> : <span {...props} />;
}

function Findings({ findings }: { findings: ReviewFinding[] }) {
	return (
		<ul className="flex flex-col gap-1.5">
			{findings.map((finding, i) => {
				const blocking = finding.severity === "blocking";
				return (
					<li key={i} className={`border-l-2 pl-2.5 break-words ${blocking ? "border-warn" : "border-line text-muted"}`}>
						{finding.file && (
							<span className="mr-2 font-mono text-xs text-muted">
								{finding.file}
								{finding.line ? `:${finding.line}` : ""}
							</span>
						)}
						{/* Inline code only: summaries are one line. */}
						{finding.summary.split("`").map((part, j) =>
							j % 2 ? (
								<code key={j} className="rounded bg-(--code) px-1 text-[0.88em]">
									{part}
								</code>
							) : (
								part
							),
						)}
					</li>
				);
			})}
		</ul>
	);
}

/** A `stomp.review` entry: the verdict, who reviewed which commit, then blocking findings and the notes. */
export function ReviewCard({ review }: { review: ReviewRecord }) {
	const blocking = review.findings.filter((f) => f.severity === "blocking");
	const notes = review.findings.filter((f) => f.severity !== "blocking");
	return (
		<div data-review className="flex scroll-mt-4 flex-col gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-sm">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<Verdict review={review} />
				<span className="min-w-0 text-xs text-muted">
					reviewed by <span className="text-fg">{modelLabel(review.reviewer)}</span> ({review.family}) · {review.rounds}{" "}
					{review.rounds === 1 ? "round" : "rounds"} · <span className="font-mono">{review.sha.slice(0, 8)}</span>
				</span>
			</div>
			{review.verdict === "failed" && <p className="text-xs text-muted">The reviewer gave no verdict. Nothing is blocked.</p>}
			{blocking.length > 0 && <Findings findings={blocking} />}
			{notes.length > 3 ? (
				<details>
					<summary className="cursor-pointer text-xs text-muted select-none">{notes.length} notes</summary>
					<div className="mt-1.5">
						<Findings findings={notes} />
					</div>
				</details>
			) : (
				notes.length > 0 && <Findings findings={notes} />
			)}
		</div>
	);
}
