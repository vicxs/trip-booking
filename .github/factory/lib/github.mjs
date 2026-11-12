// Minimal GitHub REST client for the factory (no dependencies).

export const WORKFLOW_FILE = 'factory.yml';

export function createGitHub({ token, repository, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  if (!token) throw new Error('GH_TOKEN is required');
  if (!repository) throw new Error('GITHUB_REPOSITORY is required');
  const repo = `/repos/${repository}`;

  async function call(method, path, body, { allow404 = false } = {}) {
    const res = await fetchImpl(path.startsWith('http') ? path : `${apiUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (allow404 && res.status === 404) return { data: null, res };
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    }
    const data = res.status === 204 ? null : await res.json();
    return { data, res };
  }

  async function paginate(path) {
    const out = [];
    let url = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
    while (url) {
      const { data, res } = await call('GET', url);
      out.push(...(Array.isArray(data) ? data : (data.workflow_runs ?? [])));
      url = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    }
    return out;
  }

  const enc = encodeURIComponent;

  return {
    getIssue: async (n) => (await call('GET', `${repo}/issues/${n}`)).data,
    listComments: (n) => paginate(`${repo}/issues/${n}/comments`),
    listIssueEvents: (n) => paginate(`${repo}/issues/${n}/events`),
    getComment: async (id) => (await call('GET', `${repo}/issues/comments/${id}`)).data,
    createComment: async (n, body) => (await call('POST', `${repo}/issues/${n}/comments`, { body })).data,
    updateComment: async (id, body) => (await call('PATCH', `${repo}/issues/comments/${id}`, { body })).data,
    addLabels: (n, labels) => call('POST', `${repo}/issues/${n}/labels`, { labels }),
    removeLabel: (n, label) => call('DELETE', `${repo}/issues/${n}/labels/${enc(label)}`, null, { allow404: true }),
    listOpenIssuesWithLabel: async (label) =>
      (await paginate(`${repo}/issues?state=open&labels=${enc(label)}`)).filter((i) => !i.pull_request),
    listOpenPulls: () => paginate(`${repo}/pulls?state=open`),
    createPull: async (p) => (await call('POST', `${repo}/pulls`, p)).data,
    getBranchSha: async (branch) =>
      (await call('GET', `${repo}/git/ref/heads/${branch}`, null, { allow404: true })).data?.object.sha ?? null,
    listBranches: async (prefix) =>
      (await paginate(`${repo}/git/matching-refs/heads/${prefix}`)).map((r) => r.ref.replace(/^refs\/heads\//, '')),
    createBranch: (branch, sha) => call('POST', `${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha }),
    deleteBranch: (branch) => call('DELETE', `${repo}/git/refs/heads/${branch}`),
    dispatch: (inputs, ref = 'main') =>
      call('POST', `${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`, { ref, inputs }),
    listRecentRuns: async () =>
      (await call('GET', `${repo}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=100`)).data.workflow_runs,
  };
}
