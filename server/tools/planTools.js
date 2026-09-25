const { DatabaseAPI } = require('../services/db/api');
const db = new DatabaseAPI(require('../database'));

/**
 * Plan Mode tools (Fase C — item 3 do plano).
 *
 * Um plano atual por conversa, armazenado na coluna conversations.plan.
 * updatePlan substitui o plano atual; getPlan devolve-o.
 * Available to MAIN (updatePlan + getPlan) and getPlan read-only to subbot.
 */
function createPlanTools(conversationId) {
  return {
    updatePlan: {
      name: 'updatePlan',
      description: `Replace the current plan for this conversation with the provided markdown.

Use this to create or update the single authoritative plan for the work ahead. An empty or null plan clears the current plan. There is no plan history: this tool replaces the current plan entirely.

Keep the plan concise and actionable (goal, steps, acceptance criteria). The plan is displayed sticky in the UI and is available to the user.`,
      parameters: {
        type: 'object',
        properties: {
          plan: {
            type: 'string',
            description: 'The full markdown plan for this conversation. Pass empty string/null to clear the plan.'
          }
        },
        required: ['plan']
      },
      handler: async ({ plan }) => {
        return db.updatePlan(conversationId, plan);
      }
    },

    getPlan: {
      name: 'getPlan',
      description: 'Get the current plan for this conversation. Returns null when no plan has been set.',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const plan = db.getPlan(conversationId);
        return plan == null ? { plan: null } : { plan };
      }
    }
  };
}

module.exports = { createPlanTools };
