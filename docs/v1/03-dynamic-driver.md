# Conjunction V1 — Lot 3: Dynamic Driver

Tu travailles uniquement après validation des Lots 1 et 2.

Construis le premier Driver fonctionnel de Conjunction.

Il doit piloter des Invocations existantes ; il ne doit pas devenir propriétaire de Git, de la verification ou des adapters.

---

## Principe fondamental

Le Driver décide :

```text
WHAT needs to happen
WHO should attempt it
HOW MUCH reasoning it deserves
WHETHER the result is sufficient
```

Conjunction décide :

```text
what is allowed
what must be verified
budgets
isolation
runtime availability
mandatory review
lifecycle/state transitions
```

Le Driver choisit la stratégie.

Conjunction impose les garanties.

---

## Pas de plan figé obligatoire

Ne construis pas un pipeline qui impose :

```text
driver creates 5 subtasks upfront
then blindly execute 1..5
```

Le Driver doit fonctionner par boucle de décision :

```text
observe state/evidence
→ decide next action
→ invoke
→ observe evidence
→ decide again
```

Il peut créer 1, 2, 5 ou davantage d'Invocations selon la tâche, dans les limites de policy/budget.

Le brief original reste la source de vérité.

Une restatement ou un plan du Driver ne remplace jamais silencieusement le brief.

---

## V1 strictement séquentielle

Une seule invocation writable active à la fois.

Aucun parallélisme.

Le modèle et les événements doivent cependant éviter de rendre le parallélisme futur impossible.

N'introduis pas de dependency graph tant qu'il n'est pas réellement nécessaire.

---

## Décisions structurées

Les sorties du Driver qui contrôlent Conjunction doivent être structurées et validées.

Prévois le plus petit ensemble d'actions nécessaire, par exemple :

```text
delegate
retry
switch_target
request_verification
accept
stop
```

Tu peux adapter les noms si une modélisation plus propre ressort du code réel.

N'utilise pas du parsing fragile de prose.

Une décision refusée/invalide ne doit jamais être exécutée silencieusement.

---

## Dynamic workers

Le Driver choisit parmi les `ExecutionTarget` autorisés.

Il décide pour chaque Invocation :

- rôle ;
- objectif borné ;
- target ;
- reasoning effort.

Aucun :

```text
FrontendAgent
BackendAgent
TestingAgent
DatabaseAgent
```

codé en dur.

Ces spécialisations sont des objectifs/contextes d'Invocation, pas des classes de domaine.

---

## Intensité / Reasoning effort

`ReasoningEffort` est une décision de première classe :

```text
minimal
low
medium
high
maximum
```

Le Driver peut faire :

```text
low → medium → high
```

ou directement sélectionner `maximum` s'il estime le problème complexe.

Ne confonds pas reasoning effort avec :

- nombre de retries ;
- temps maximum ;
- nombre d'Invocations ;
- budget global.

Un modèle peut avoir un effort élevé avec un budget d'exécution court, ou l'inverse.

---

## Stalled worker / redélégation

Le Driver doit pouvoir constater qu'une Invocation ne progresse plus.

Les faits déterministes doivent être calculés par Conjunction autant que possible :

- verification répétitivement identique ;
- absence de progrès vérifiable ;
- acceptance evidence inchangée ;
- budget/temps dépassé ;
- nombre de tentatives ;
- même failure signature répétée.

Le Driver peut alors :

```text
retry same target
raise effort
select another target
alter the subtask
stop
```

Une autre cible = nouvelle Invocation.

Ne blackliste jamais globalement un modèle simplement parce qu'une tâche a échoué.

La première chose évaluée est **la progression de cette Invocation sur cette tâche**.

---

## Handoff propre

Lors d'une redélégation, ne transfère pas tout le transcript précédent.

Construis un paquet borné :

```text
original brief
current objective/scope
current diff/evidence
what passed
what failed
why previous invocation stopped
```

Le nouveau worker doit recevoir suffisamment d'information pour reprendre sans hériter de toutes les divagations du précédent.

---

## Verification

Le Driver ne peut jamais transformer :

```text
deterministic verification = red
```

en :

```text
accepted
```

si cette verification est mandatory.

Le Driver peut :

- demander une correction ;
- changer de target ;
- changer d'effort ;
- réévaluer la stratégie ;
- stopper.

Mais pas déclarer verte une preuve déterministe rouge.

---

## Critic indépendant

Le critic reste :

- indépendant ;
- read-only ;
- potentiellement sur un autre runtime ;
- potentiellement sur un autre modèle.

Il n'a pas besoin du transcript complet du Worker.

Privilégie :

```text
brief
scope
diff
verification evidence
bounded context
```

---

## Capabilities et permissions

Le Driver doit raisonner à partir de ce qui est réellement disponible.

Il ne doit pas inventer :

- un runtime absent ;
- une capability inexistante ;
- un niveau d'effort non supporté ;
- un accès interdit.

Conjunction reste responsable de valider les décisions du Driver avant exécution.

---

## Tests obligatoires

Avec fake Driver + fake workers, démontre au minimum :

1. tâche simple → un worker ;
2. tâche nécessitant deux workers successifs ;
3. worker échoue → même worker retry ;
4. worker stagne → autre target ;
5. effort faible → escalade effort ;
6. verification rouge → Driver ne peut pas accepter ;
7. Driver stop → run failed avec raison ;
8. critic indépendant ;
9. aucune Invocation writable concurrente ;
10. parent/child relationship correctement persistée.

Ajoute un E2E déterministe utilisant :

- vrais worktrees ;
- vrais checks ;
- fake agents.

Ce test doit prouver le workflow sans consommer de tokens.

---

## Non-goals

Ne construis pas encore :

- Observer ;
- live eval ;
- parallélisme ;
- routing historique ;
- apprentissage des performances modèles ;
- server ;
- triggers externes ;
- workflow engine générique ;
- worker-spawned swarms.

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
Driver decision loop
Invocation lifecycle
Stall detection
Escalation behavior
Verification guarantees
Critic independence
Tests added
Commands executed + results
Deferred intentionally
```

Ne commence aucun travail du Lot 4.
