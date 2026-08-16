# Conjunction V1 — Lot 2: Multi-runtime Execution

Tu travailles après validation complète du Lot 1.

Le Lot 1 doit déjà avoir introduit :

- `Invocation` ;
- `ExecutionTarget` ;
- `Role` ;
- `ReasoningEffort` ;
- instructions neutres pour `AgentAdapter` ;
- architecture tests ;
- adapter contract tests.

Ne reviens pas sur ces abstractions sans raison démontrable.

---

## Objectif

Permettre à un même Run d'avoir plusieurs Invocations potentiellement exécutées par différents `AgentAdapter`.

Remplacer le modèle :

```text
OrchestratorDeps.agent = one adapter
```

par un mécanisme minimal de résolution de runtime.

Introduis un `RuntimeRegistry` ou abstraction équivalente **très petite** :

```text
runtime id → AgentAdapter
```

Pas de plugin marketplace.

Pas de dynamic package loading.

Pas de DI framework.

---

## Deuxième runtime

Implémente **exactement un deuxième adapter réel**.

Utilise Claude Code comme second runtime de validation sauf incompatibilité technique démontrée dans l'environnement ; dans ce cas documente le problème avant de choisir une alternative.

Consulte la documentation primaire/current CLI et le `--help` installé plutôt que de deviner les flags.

Il doit passer exactement la même contract suite que Codex.

---

## Target indépendant par invocation

Il doit devenir possible d'avoir conceptuellement :

```text
invocation 1
role: worker
runtime: codex

invocation 2
role: critic
runtime: claude-code
```

sans que core importe ces runtimes.

---

## Reasoning effort

Implémente le mapping runtime-specific uniquement lorsque le runtime le supporte réellement.

Si usage non supporté :

- capability explicitement signalée ;
- fallback documenté ;
- jamais de simulation silencieuse.

---

## Configuration V1

Ajoute le mécanisme **le plus petit et explicite** permettant à l'utilisateur de déclarer les targets disponibles.

Ne crée pas encore de routing intelligent.

Le système doit simplement savoir :

```text
voici les targets que le Driver aura le droit d'utiliser
```

Les overrides CLI sont acceptables.

Une configuration projet simple est acceptable si elle évite une explosion de flags.

N'ajoute aucune dépendance juste pour parser un format de configuration.

---

## Events et persistence

Chaque Invocation doit pouvoir être attribuée à son runtime/model/effort.

Les events futurs doivent être attribuables à une Invocation, pas seulement au Run.

Les sorties de deux Invocations ne doivent jamais devenir ambiguës dans les logs.

Les anciennes données de Run doivent rester lisibles ou bénéficier d'une compatibilité simple explicitement testée.

---

## Tests obligatoires

Il faut prouver avec fake adapters :

```text
invocation A → runtime A
invocation B → runtime B
```

et vérifier que :

- sorties non mélangées ;
- metadata correcte ;
- events attribuables à l'invocation ;
- model/runtime/effort persistés ;
- ancienne exécution mono-Codex fonctionne toujours ;
- Codex et le second adapter passent la même contract suite.

---

## Validation réelle

Lorsque l'environnement le permet, effectue au moins un smoke test manuel contrôlé avec les deux runtimes installés.

Ne transforme pas ce smoke test en test Vitest.

Documente exactement :

- runtime détecté ;
- version ;
- commande réellement utilisée ;
- comportement read-only ;
- comportement reasoning effort ;
- limitations observées.

---

## Non-goals

Pas encore de :

- Driver ;
- routing automatique ;
- parallélisme ;
- Observer ;
- live eval automatisé ;
- server ;
- workflow triggers ;
- base de données ;
- historique de performance des modèles.

---

## Validation obligatoire

Avant de terminer :

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Termine par :

```text
What changed
Runtime registry design
Second adapter behavior
Reasoning effort mapping
Compatibility notes
Tests added
Commands executed + results
Known runtime limitations
Deferred intentionally
```

Ne commence aucun travail du Lot 3.
