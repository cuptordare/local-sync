// A stand-in for a read-only REST API shaped like GitHub's issues endpoint:
//
//   GET /repos/{owner}/{repo}/issues?state=open|closed|all&per_page=N[&page=N]
//
// It answers with a real `Response`: a JSON array of issues plus a `Link` header pointing at
// the next page, so the fetchPage code in main.js is the same code you'd write against the
// real API. (Jira and Azure DevOps paginate differently -- startAt/total, continuation tokens --
// but the shape of fetchPage is the same: fetch one page, say where the next one starts.)
//
// The data changes over time -- issues get edited, closed, opened, and deleted -- the way
// a real project does while you're looking at it.

const TITLES = [
	"Login button misaligned on Safari",
	"Add dark mode",
	"Crash when uploading empty file",
	"Improve search relevance",
	"Typo in onboarding email",
	"Slow dashboard on large accounts",
	"Export to CSV drops unicode",
	"Session expires too quickly",
	"Keyboard shortcuts for navigation",
	"Broken link in footer",
	"Rate limit errors not surfaced",
	"Avatar upload ignores EXIF rotation",
];
const LABELS = ["bug", "enhancement", "docs", "performance"];
const PEOPLE = ["ana", "ben", "chen", "dee"];

export function createFakeIssueApi({ latencyMs = 600 } = {}) {
	let failing = false;
	let nextNumber = 1;
	let tick = 0;
	const issues = [];

	const add = (repo, title, state = "open") => {
		const n = nextNumber++;
		issues.push({
			repo,
			number: n,
			title,
			state,
			labels: [{ name: LABELS[n % LABELS.length] }],
			user: { login: PEOPLE[n % PEOPLE.length] },
			updated_at: new Date(Date.now() - (60 - n) * 3_600_000).toISOString(),
		});
		return n;
	};
	// acme/web: 25 issues (21 open), so the default view spans three pages of 10.
	for (let i = 0; i < 25; i++)
		add("acme/web", TITLES[i % TITLES.length], i % 6 === 5 ? "closed" : "open");
	for (let i = 0; i < 8; i++)
		add(
			"acme/api",
			TITLES[(i + 5) % TITLES.length],
			i % 4 === 3 ? "closed" : "open",
		);

	const find = (number) => issues.find((i) => i.number === number);
	const touch = (issue) => {
		issue.updated_at = new Date().toISOString();
	};

	const api = {
		async fetch(url) {
			await new Promise((resolve) => setTimeout(resolve, latencyMs));
			if (failing)
				return Response.json(
					{ message: "Service Unavailable" },
					{ status: 503 },
				);
			const u = new URL(url, "https://api.example.test");
			const repo = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues$/)?.[1];
			if (repo === undefined)
				return Response.json({ message: "Not Found" }, { status: 404 });
			const state = u.searchParams.get("state") ?? "open";
			const perPage = Number(u.searchParams.get("per_page") ?? 30);
			const page = Number(u.searchParams.get("page") ?? 1);
			const matching = issues
				.filter(
					(i) => i.repo === repo && (state === "all" || i.state === state),
				)
				.sort((a, b) => b.number - a.number);
			const headers = {};
			if (page * perPage < matching.length) {
				u.searchParams.set("page", String(page + 1));
				headers.Link = `<${u.pathname}${u.search}>; rel="next"`;
			}
			const body = matching
				.slice((page - 1) * perPage, page * perPage)
				.map(({ repo: _repo, ...issue }) => issue);
			return Response.json(structuredClone(body), { headers });
		},

		setFailing(value) {
			failing = value;
		},

		// --- What other people do at the source while you're looking ---
		rename(number, title) {
			const issue = find(number);
			issue.title = title;
			touch(issue);
		},
		close(number) {
			const issue = find(number);
			issue.state = "closed";
			touch(issue);
		},
		open(repo, title) {
			return add(repo, title);
		},
		remove(number) {
			issues.splice(issues.indexOf(find(number)), 1); // e.g. deleted as spam
		},
		simulateActivity() {
			const open = issues.filter((i) => i.state === "open");
			const pick = open[(tick * 7) % open.length];
			const actions = [
				() => api.rename(pick.number, `${pick.title} (updated)`),
				() => api.close(pick.number),
				() => api.open(pick.repo, TITLES[tick % TITLES.length]),
				() => api.remove(pick.number),
			];
			actions[tick++ % actions.length]();
		},
	};
	return api;
}
