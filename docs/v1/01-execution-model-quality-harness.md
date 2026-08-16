# Conjunction V1 — Lot 1: Execution Model & Architecture Harness

Tu travailles dans le repository Conjunction, à partir de la branche `feat/brief-workflows`.

Avant toute modification, lis impérativement :

- `AGENTS.md`
- `docs/architecture-review.md`
- `docs/brief-workflow-design.md`
- `conjunction-handoff/01-VISION.md`
- `conjunction-handoff/03-ARCHITECTURE.md`
- `conjunction-handoff/05-DECISIONS.md`

Inspecte également le code actuel avant de proposer des changements :

- `src/core/agent.ts`
- `src/core/run.ts`
- `src/core/workflow.ts`
- `src/core/orchestrator.ts`
- `src/core/events.ts`
- `src/cli/run-command.ts`
- `src/cli/cli.ts`
- `src/adapters/codex/*`

**Ne commence pas par coder.**

Commence par confronter ce brief au code réel et écris une courte note indiquant :

1. les changements réellement nécessaires ;
2. les abstractions existantes qui peuvent être conservées ;
3. les risques de sur-conception ;
4. les éventuels points du brief incompatibles avec le repository actuel.

Ensuite implémente uniquement ce lot.

---

## Vision à préserver

Conjunction n'est pas un nouvel agent de coding.

Conjunction orchestre des runtimes existants.

La cible V1 est :

```text
Driver → dynamic Invocations → Workers → deterministic verification
       → Driver decisions → Review → Result
```

Le Driver décidera plus tard dynamiquement du nombre de workers nécessaires.

Ce lot **ne doit PAS encore implémenter le Driver**.

Il prépare uniquement le modèle suffisamment propre pour que le Lot 3 puisse le faire sans réécrire le système.

---

## 1. Introduire `Invocation` comme unité d'exécution d'un agent

Aujourd'hui `Run.runtime` et `Run.attempts` supposent implicitement qu'un run correspond à un seul runtime.

Cette hypothèse ne survivra pas au Driver/Workers.

Introduis le plus petit modèle permettant :

```text
Run
├── Invocation(driver)
├── Invocation(worker)
├── Invocation(worker)
└── Invocation(critic)
```

Une Invocation doit au minimum pouvoir porter :

- identité ;
- `runId` ;
- éventuel `parentInvocationId` ;
- rôle ;
- cible d'exécution ;
- reasoning effort ;
- timestamps ;
- état/outcome ;
- raison de terminaison.

Ne transforme pas `Invocation` en framework générique.

### Rôles

La terminologie canonique devient :

```text
driver
worker
critic
```

Le design doc utilise actuellement les termes Lead/Supervisor pour le futur composant.

**Ne crée pas à la fois Lead, Supervisor et Driver.**

Pour la nouvelle architecture, le concept produit canonique est `driver`.

Mets à jour la documentation future en conséquence lorsque nécessaire.

`observer` n'est PAS encore requis dans ce lot.

---

## 2. Séparer Role / Runtime / Model / Effort

Ces concepts ne doivent jamais être fusionnés.

Exemple conceptuel :

```text
Invocation

role: worker

target:
  runtime: codex-cli
  model: optional-model-id

reasoningEffort: medium
```

Introduis un `ExecutionTarget` minimal.

Runtime et model restent des identifiants opaques pour core.

Aucun nom de fournisseur/modèle concret ne doit apparaître dans `src/core/`.

Introduis également une intention de reasoning effort portable :

```text
minimal
low
medium
high
maximum
```

Ce niveau est une intention Conjunction.

Les adapters décideront ultérieurement comment le traduire dans les options propres à chaque runtime.

Un runtime incapable de supporter un niveau spécifique ne doit jamais faire croire qu'il l'a appliqué.

---

## 3. Corriger la frontière des prompts

Actuellement `AgentAdapter` reçoit une `Task` et `CodexAdapter` peut construire lui-même le prompt initial.

Cette responsabilité est au mauvais niveau pour une architecture multi-runtime.

Règle :

> Conjunction décide WHAT to say; adapter decides HOW to transmit it.

Le contenu sémantique destiné à l'agent doit être construit avant d'entrer dans l'adapter.

L'adapter ne doit pas connaître la façon dont une Task devient des instructions produit.

Évite de reproduire plus tard :

```text
adapters/codex/prompt.ts
adapters/claude/prompt.ts
adapters/opencode/prompt.ts
```

contenant trois interprétations différentes de la même Task.

Le contrat `AgentAdapter` doit devenir suffisamment neutre pour recevoir des instructions déjà préparées.

Ne crée pas encore une énorme abstraction `ContextEngine`.

Une chaîne/packet explicite et typé minimal suffit si c'est le choix le plus propre.

---

## 4. Préserver la compatibilité du workflow actuel

Après ce refactor :

```text
conjunction run ...
```

doit continuer à avoir exactement le comportement actuel :

```text
Codex worker
→ verification
→ correction bounded
→ optional critic
→ land
```

Le nouveau modèle ne doit pas obliger à avoir un Driver.

Le workflow `single` reste parfaitement valide.

Les anciens fichiers de run déjà enregistrés doivent soit rester lisibles, soit bénéficier d'un mécanisme de compatibilité simple et explicitement testé.

Ne fais pas une migration de persistence complexe.

---

## 5. Quality Harness architectural

Ce lot doit également transformer certaines règles du repository en contraintes exécutables.

Ajoute des tests d'architecture qui échouent réellement si les frontières suivantes sont violées :

```text
core            X→ concrete adapters
core            X→ CLI/UI
workspace       X→ core
verification    X→ core
```

Les règles présentes uniquement dans `AGENTS.md` ne suffisent pas.

Évite une grosse dépendance d'architecture testing si quelques tests TypeScript/Vitest simples suffisent.

---

## 6. AgentAdapter contract tests

Crée une suite contractuelle réutilisable permettant à chaque futur adapter de prouver les propriétés communes de `AgentAdapter`.

Elle doit pouvoir tester au minimum ce qui est testable sans lancer de vrai modèle :

- résultat process structuré ;
- cancellation ;
- timeout contract ;
- streaming ;
- read-only lorsqu'applicable ;
- aucune décision métier pass/fail ;
- traitement correct des instructions ;
- absence de connaissance Git/worktree dans l'adapter.

Le CodexAdapter doit passer ce contrat.

Ne lance pas réellement Codex dans Vitest.

---

## 7. Invariants à protéger

Les tests doivent notamment préserver :

1. un adapter concret n'entre jamais dans core ;
2. deterministic verification reste l'autorité sur ses propres checks ;
3. un run terminal ne redevient jamais actif ;
4. le critic reste read-only ;
5. les corrections restent bornées ;
6. les worktrees restent isolés ;
7. les décisions importantes restent observables via events ;
8. ancien workflow `single` fonctionne toujours.

---

## 8. Ne PAS implémenter

Dans ce lot, interdiction d'implémenter spéculativement :

- Driver LLM ;
- second runtime ;
- router ;
- parallelism ;
- scheduler ;
- generic workflow engine ;
- server ;
- database ;
- Observer ;
- live eval ;
- stats historiques ;
- triggers.

Si une abstraction ne possède aucun producteur ou consommateur concret dans ce lot ou le lot suivant immédiat, questionne sa nécessité avant de l'ajouter.

---

## Validation obligatoire

Avant de terminer :

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Ajoute les tests nécessaires pour prouver la compatibilité de l'ancien workflow.

Termine par un rapport :

```text
What changed
Architectural decisions
Invariants now enforced
Compatibility notes
Tests added
Commands executed + results
Deferred intentionally
```

N'affirme pas qu'une commande passe si elle n'a pas réellement été exécutée.

Ne commence aucun travail du Lot 2.
