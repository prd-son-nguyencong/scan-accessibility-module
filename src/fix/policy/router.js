import { canGenerateProposal, lookupPolicyDecision } from './registry.js';

export function routeFixUnitPolicies(fixUnits = []) {
  return fixUnits.map((unit) => {
    const decision = lookupPolicyDecision(unit);
    return {
      fixUnitId: unit.fixUnitId,
      decision,
      proposalAllowed: canGenerateProposal(decision),
    };
  });
}

export function partitionProposableUnits(fixUnits = []) {
  const routed = routeFixUnitPolicies(fixUnits);
  const proposable = [];
  const blocked = [];
  for (let index = 0; index < fixUnits.length; index += 1) {
    const route = routed[index];
    if (route.proposalAllowed) proposable.push(fixUnits[index]);
    else blocked.push({ unit: fixUnits[index], decision: route.decision });
  }
  return { proposable, blocked, routed };
}
