// In-memory fake of the GitHub REST endpoints the factory CLI uses.
import { createServer } from 'node:http';

export function fakeGitHub(seed = {}) {
  const db = {
    issues: {},
    comments: new Map(),
    pulls: [],
    refs: { main: 'main000' },
    dispatches: [],
    runs: [],
    nextId: 1000,
    ...seed,
  };

  const issueView = (i) => ({
    number: i.number,
    title: i.title,
    body: i.body ?? '',
    state: i.state ?? 'open',
    created_at: i.created_at ?? '2026-11-01T00:00:00Z',
    labels: i.labels.map((name) => ({ name })),
  });

  const routes = [
    ['GET', /^\/repos\/o\/r\/issues\/(\d+)$/, (m) => issueView(db.issues[m[1]])],
    ['GET', /^\/repos\/o\/r\/issues\/(\d+)\/comments$/, (m) =>
      [...db.comments.values()].filter((c) => c.issue === Number(m[1]))],
    ['GET', /^\/repos\/o\/r\/issues\/(\d+)\/events$/, (m) => db.issues[m[1]].events ?? []],
    ['GET', /^\/repos\/o\/r\/issues\/comments\/(\d+)$/, (m) => db.comments.get(Number(m[1]))],
    ['PATCH', /^\/repos\/o\/r\/issues\/comments\/(\d+)$/, (m, body) => {
      const c = db.comments.get(Number(m[1]));
      c.body = body.body;
      return c;
    }],
    ['POST', /^\/repos\/o\/r\/issues\/(\d+)\/comments$/, (m, body) => {
      const c = { id: db.nextId++, issue: Number(m[1]), body: body.body, author_association: 'NONE', user: { login: 'factory[bot]' }, created_at: 'now' };
      db.comments.set(c.id, c);
      return c;
    }],
    ['POST', /^\/repos\/o\/r\/issues\/(\d+)\/labels$/, (m, body) => {
      const i = db.issues[m[1]];
      for (const l of body.labels) if (!i.labels.includes(l)) i.labels.push(l);
      return [];
    }],
    ['DELETE', /^\/repos\/o\/r\/issues\/(\d+)\/labels\/(.+)$/, (m) => {
      const i = db.issues[m[1]];
      const name = decodeURIComponent(m[2]);
      if (!i.labels.includes(name)) return 404;
      i.labels = i.labels.filter((l) => l !== name);
      return [];
    }],
    ['GET', /^\/repos\/o\/r\/issues$/, (m, body, q) =>
      Object.values(db.issues)
        .filter((i) => (i.state ?? 'open') === 'open' && i.labels.includes(q.get('labels')))
        .map(issueView)],
    ['GET', /^\/repos\/o\/r\/pulls$/, () => db.pulls.filter((p) => p.state === 'open')],
    ['POST', /^\/repos\/o\/r\/pulls$/, (m, body) => {
      const p = { number: db.nextId++, state: 'open', html_url: `https://github.com/o/r/pull/${db.nextId - 1}`, head: { ref: body.head }, body: body.body, title: body.title };
      db.pulls.push(p);
      return p;
    }],
    ['GET', /^\/repos\/o\/r\/git\/ref\/heads\/(.+)$/, (m) => (db.refs[m[1]] ? { object: { sha: db.refs[m[1]] } } : 404)],
    ['GET', /^\/repos\/o\/r\/git\/matching-refs\/heads\/(.+)$/, (m) =>
      Object.keys(db.refs).filter((b) => b.startsWith(m[1])).map((b) => ({ ref: `refs/heads/${b}` }))],
    ['POST', /^\/repos\/o\/r\/git\/refs$/, (m, body) => {
      db.refs[body.ref.replace('refs/heads/', '')] = body.sha;
      return {};
    }],
    ['DELETE', /^\/repos\/o\/r\/git\/refs\/heads\/(.+)$/, (m) => {
      delete db.refs[m[1]];
      return 204;
    }],
    ['POST', /^\/repos\/o\/r\/actions\/workflows\/factory\.yml\/dispatches$/, (m, body) => {
      db.dispatches.push(body);
      return 204;
    }],
    ['GET', /^\/repos\/o\/r\/actions\/workflows\/factory\.yml\/runs$/, () => ({ workflow_runs: db.runs })],
  ];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const route = routes.find(([method, re]) => method === req.method && re.test(url.pathname));
    if (!route) {
      res.writeHead(500).end(`fake-github: no route for ${req.method} ${url.pathname}`);
      return;
    }
    const result = route[2](url.pathname.match(route[1]), raw ? JSON.parse(raw) : null, url.searchParams);
    if (typeof result === 'number') res.writeHead(result).end();
    else res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  });

  return {
    db,
    async listen() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${server.address().port}`;
    },
    close: () => new Promise((r) => server.close(r)),
    commentsOn: (n) => [...db.comments.values()].filter((c) => c.issue === n).map((c) => c.body),
  };
}
