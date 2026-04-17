```markdown
. 📂 compliance-engine
├── 📄 README.md
└── 📂 docs/
│  ├── 📄 architecture-design-document.md
│  ├── 📄 backlog.md
│  ├── 📄 product-requirements-document.md
│  ├── 📄 software-requirements-specification.md
│  ├── 📄 technical-design-document.md
├── 📄 package.json
└── 📂 src/
│  └── 📂 config/
│    ├── 📄 worker.ts
│  └── 📂 crypto/
│    ├── 📄 aes.ts
│    ├── 📄 envelope.ts
│    ├── 📄 hmac.ts
│  └── 📂 db/
│    ├── 📄 graph.ts
│    ├── 📄 identifiers.ts
│    ├── 📄 migrations.ts
│  └── 📂 engine/
│    ├── 📄 contracts.ts
│    ├── 📄 notifier.ts
│    ├── 📄 shredder.ts
│    ├── 📄 support.ts
│    ├── 📄 vault.ts
│  ├── 📄 index.ts
│  └── 📂 network/
│    ├── 📄 outbox.ts
│  ├── 📄 worker.ts
└── 📂 tests/
│  ├── 📄 config.test.ts
│  ├── 📄 crypto.test.ts
│  ├── 📄 fetch-dispatcher.test.ts
│  ├── 📄 graph.test.ts
│  └── 📂 helpers/
│    ├── 📄 db.ts
│  ├── 📄 notifier.test.ts
│  ├── 📄 outbox.test.ts
│  ├── 📄 shredder.test.ts
│  ├── 📄 vault.test.ts
│  ├── 📄 worker.test.ts
└── 📄 tsconfig.json
```