# Security policy

## Supported versions

Only the latest [release](https://github.com/mickeiik/izle/releases) gets security fixes. Fixes ship as a normal
release of the server package and the TV app; the [changelog](CHANGELOG.md) says what changed and how to update.

## Reporting a vulnerability

Report it privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**. Only
you and the maintainers see the report and the discussion that follows. There is no e-mail address for reports.
Please do not open a public issue, pull request or discussion for a vulnerability.

A useful report says which version is affected (`izle-server --version`, About in the TV's hidden menu), how the
server is set up (LAN only, behind a reverse proxy, Docker), what an attacker needs (a position on the network, a
device token, the admin token) and how to reproduce the problem.

## Scope

In scope:
- anything that lets a TV, or a client without a token, reach the admin API, or lets one TV read or change another
  TV's data;
- a media-proxy session that can be made to fetch arbitrary URLs, or that leaks upstream request headers;
- upstream stream URLs, upstream headers, tokens or playlist text reaching the server's log or the TV;
- the admin page executing or loading third-party content;
- pairing-code abuse: guessing or taking over a code, or getting a device token without the owner's approval.

Out of scope:
- the demo CDNs and hosts that the sample catalog links to;
- owners' private catalogs and resolver modules: the server runs a resolver module as trusted code in its own
  process;
- deployments that ignore the [self-hosting guide](docs/deploy/self-hosting.md) (HTTPS through a reverse proxy, the
  admin page and API limited to private addresses by the Caddyfile's optional block, the systemd unit's sandbox,
  `trustedProxies` so that rate limits see the real client), such as port 8787 open to the internet without TLS;
- denial of service by a device that already holds a valid token.

## What to expect

An acknowledgement within a week. A confirmed vulnerability is fixed in a normal release, listed in the changelog,
and credited to you in the report and the release notes if you want.
