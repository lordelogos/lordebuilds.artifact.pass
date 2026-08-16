# Third-party notices

Artifact Share depends on open-source packages whose license metadata is available from the installed package manager tree with:

```sh
pnpm licenses list --prod
```

The release gate accepts permissive Apache-2.0, BSD-2-Clause, CC0-1.0, ISC, MIT, and dual MIT/Apache-2.0 dependencies. It contains one narrow reviewed exception for platform-specific `@img/sharp-libvips-*` packages licensed under LGPL-3.0-or-later. Those are unmodified optional binaries distributed by the upstream `sharp` dependency used through Wrangler; they are not copied into this repository's source or bundled plugin/setup JavaScript artifacts.

`pnpm security:licenses` fails if another package introduces that license or if any unreviewed license appears. Package license files remain included by their upstream distributions.
