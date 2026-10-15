# pr-viewer

Composer pill that appears when the current workspace's branch has a pull request and opens that PR in a custom PR viewer.

The viewer URL is the PR's GitHub path on a different host, e.g. `github.com/cognitoforms/cognito/pull/18155` becomes `<VIEWER_BASE_URL>/cognitoforms/cognito/pull/18155`. Change `VIEWER_BASE_URL` in `client/pr-pill.ts` to point at another viewer.

The PR comes from the workspace's GitHub status, so it needs GitHub features enabled on the daemon (`gh` authenticated).
