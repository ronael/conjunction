# Conjunction V1 — Lot 4: Run Intelligence, Observer & Live Eval

Tu travailles uniquement après validation complète des Lots 1, 2 et 3.

Construis la couche permettant de comprendre objectivement comment Conjunction a travaillé.

---

## Principe

Les faits viennent de Conjunction.

L'IA Observer ne crée pas les faits : elle les interprète.

Ne construis jamais un système où l'Observer invente des métriques à partir du transcript.

---

## 1. Event model par Invocation

Chaque Invocation doit être observable.

Introduis les événements réellement nécessaires, par exemple :

```text
invocation.created
invocation.started
invocation.completed
invocation.failed
invocation.stalled
invocation.superseded
```

Chaque événement doit être attribuable à :

- run ;
- invocation ;
- rôle ;
- runtime ;
- model lorsqu'il est connu ;
- reasoning effort ;
- parent éventuel ;
- timestamp.

La raison de terminaison doit être explicite.

Évite les événements redondants dont aucun consommateur n'a besoin.

---

## 2. Metrics structurées

Produis des métriques structurées pour un Run.

Au minimum lorsque disponible :

- durée totale ;
- durée par Invocation ;
- nombre d'Invocations ;
- nombre d'attempts ;
- corrections ;
- switches de target ;
- escalations d'effort ;
- verification timings ;
- review findings ;
- token usage lorsque le runtime l'expose réellement ;
- coût uniquement si calculable avec une donnée fiable.

Une métrique indisponible reste :

```text
unknown
```

ou :

```text
null
```

Ne l'invente jamais.

Une estimation doit être explicitement marquée comme estimation.

---

## 3. Run report

Ajoute un moyen simple de produire un rapport, par exemple :

```text
conjunction report <runId>
```

Le rapport doit exister en :

- format humain ;
- format JSON structuré.

Exemple de sortie humaine souhaitée :

```text
Run #abc123

Outcome
✓ completed
✓ verification passed
⚠ acceptance criterion #3 not demonstrated

Duration
total              8m42s
driver              1m14s
workers             5m51s
verification          48s
review                49s

Usage
driver              known/unknown
worker A            known/unknown
worker B            known/unknown

Delegation
3 invocations
1 target switch
1 effort escalation

Verification
typecheck           PASS
tests               PASS

Warnings
- worker B stalled before being superseded
- one criterion lacks deterministic evidence
```

---

## 4. Acceptance / evidence coverage

Lorsque le Driver a produit des objectifs ou critères structurés, le report doit pouvoir distinguer :

```text
demonstrated
failed
not demonstrated
```

Ne considère jamais :

```text
run.state === completed
```

comme synonyme de :

```text
tout le brief a été prouvé
```

Les tests existants d'un projet peuvent être insuffisants.

La notion importante est la preuve observable.

---

## 5. Observer

Introduis un rôle optionnel :

```text
observer
```

L'Observer tourne **après** le workflow principal.

Il est :

- read-only ;
- advisory ;
- indépendant du Worker ;
- incapable de modifier le Run déjà exécuté.

Il reçoit un dossier borné comprenant :

- brief ;
- Driver decisions ;
- Invocation summaries ;
- metrics ;
- verification evidence ;
- review ;
- acceptance coverage ;
- bounded diffs/evidence.

Il ne reçoit pas automatiquement tous les transcripts.

---

## 6. Ce que l'Observer doit pouvoir signaler

Exemples :

- Invocation déclarée terminée sans preuve ;
- temps disproportionné ;
- tokens disproportionnés ;
- corrections répétitives ;
- même failure répétée avant escalade ;
- effort `high/maximum` pour une tâche triviale ;
- trop de tentatives low-effort avant escalade ;
- travail incomplet ;
- sous-tâche oubliée ;
- mauvaise délégation probable ;
- target switch tardif ;
- reviewer finding significatif ignoré.

Ces observations restent des interprétations.

Le report doit toujours permettre de retrouver les faits bruts sous-jacents.

---

## 7. Live eval

Transforme le smoke test manuel actuel en vrai scénario live opt-in.

Il ne doit **jamais** tourner avec :

```bash
pnpm test
```

Ajoute une commande explicite du type :

```bash
pnpm eval:live
```

Elle doit :

1. créer un repository fixture temporaire ;
2. initialiser un Git propre ;
3. lancer réellement Conjunction ;
4. faire exécuter une petite tâche déterministe ;
5. utiliser de vrais runtimes/models ;
6. vérifier que la branche principale n'a pas été touchée avant `land` ;
7. vérifier le worktree ;
8. vérifier les checks déterministes ;
9. vérifier le lifecycle ;
10. générer le même Run Report qu'un vrai run.

---

## 8. Budget et sécurité du live eval

Le live eval doit avoir :

- opt-in explicite ;
- timeout ;
- nombre maximal d'Invocations ;
- garde de coût lorsque possible ;
- garde de tokens lorsque disponible ;
- nettoyage sûr ;
- repo fixture jetable.

Si un runtime ne donne pas de token usage fiable, ne simule pas cette information.

---

## 9. Ce qu'on teste

Ne snapshot-teste jamais le texte exact généré par une IA.

Mauvais :

```text
expect(modelOutput).toEqual("I will now...")
```

Bon :

```text
worker invocation exists
correct runtime was used
expected files changed
main branch untouched before land
verification passed
required evidence exists
events are coherent
run report generated
```

On teste les effets observables.

---

## 10. E2E déterministe + live eval

La V1 doit avoir deux niveaux :

### E2E déterministe

```text
fake Driver
fake Workers
real Orchestrator
real Git
real worktrees
real verification
real persistence
real land
```

Doit pouvoir tourner en CI.

### Live Eval

```text
real Driver model
real Worker model(s)
real runtime adapters
same reporting pipeline
```

Opt-in uniquement.

---

## V1 final acceptance

Documente et démontre un scénario réel ressemblant à :

```text
strong Driver runtime
→ cheaper Worker runtime
→ deterministic verification
→ Driver re-evaluation
→ optional target/effort escalation
→ independent critic
→ optional Observer
→ report
→ land
```

Le but est de prouver la vision de Conjunction, pas uniquement que les classes compilent.

---

## Hors scope restant après V1

Ne commence pas à implémenter :

- triggers n8n/email/GitHub ;
- server mode ;
- workflow registry générique ;
- autonomie continue ;
- distributed workers ;
- multi-worktree parallelism ;
- SQLite ;
- learning/router historique automatique.

Ces sujets appartiennent à la V2+.

---

## Validation obligatoire

Avant de terminer :

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Si `pnpm eval:live` est exécuté, reporte exactement :

- runtime/model utilisés ;
- durée ;
- tokens connus ;
- nombre d'Invocations ;
- résultat ;
- verification ;
- Observer findings ;
- limitations.

Termine par :

```text
What changed
Event model
Metrics available
Report format
Observer behavior
Deterministic E2E
Live eval behavior
Commands executed + results
Known limitations
V2 deferred
```
