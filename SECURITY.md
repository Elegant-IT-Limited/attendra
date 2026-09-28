# Security policy

Attendra handles phone calls from patients, so we take reports seriously and treat them privately.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting: the **Security** tab of this repository, then **Report a vulnerability**. Include the steps to reproduce, the commit you tested, and the impact you believe it has. Do not include real patient data; the synthetic demo data reproduces every flow.

We acknowledge reports within 5 working days, keep you updated until the issue is resolved, and credit you in the release notes unless you prefer otherwise.

## Scope

In scope: this repository's code, its default configuration, and its documentation where following it would lead to an insecure deployment. Out of scope: vulnerabilities in OpenAI, Twilio or other upstream services (report those to the vendor), and deployments that ignore [docs/hipaa.md](docs/hipaa.md).

## Supported versions

Until 1.0, only the latest release on `main` receives security fixes.
