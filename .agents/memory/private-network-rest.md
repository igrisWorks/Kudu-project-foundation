---
name: Private-network REST access
description: KuduNS must support secure, operator-approved REST APIs on factory and corporate private networks.
---

KuduNS is an industrial application and must support REST APIs hosted on private factory and corporate networks. Operators need an explicit way to trust a specific host or IP; this must not implicitly trust all private addresses.

**Why:** The user stated this product requirement.

**How to apply:** For REST discovery, preview, and synchronization, preserve explicit host-level trust alongside destination revalidation, redirect controls, origin protection, and authentication.
