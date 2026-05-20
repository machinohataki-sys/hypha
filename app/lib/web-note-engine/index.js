'use strict';

// HYPHA · W5.2 Web Note Engine — orchestrator entry (BLUEPRINT §10.1)
//
// Single facade that wires graph CRUD + layer promotion + context packing
// + entropy reduction into one slug-scoped engine object. Renderer + main
// IPC handlers both call through getEngine(slug) so the surface stays small.

const graph = require('./graph');
const types = require('./types');
const layerPromotion = require('./layer-promotion');
const contextPacket = require('./context-packet');
const entropyReduction = require('./entropy-reduction');

/**
 * Engine bound to a single curriculum slug.
 * @param {string} slug
 */
function getEngine(slug) {
  if (!slug || typeof slug !== 'string') {
    throw new Error('getEngine: slug required (non-empty string)');
  }

  return Object.freeze({
    slug,

    // --- Nodes ---
    addNode: (node) => graph.addNode(slug, node),
    getNode: (id) => graph.getNode(slug, id),
    listNodes: (filter) => graph.listNodes(slug, filter),
    updateNode: (id, patch) => graph.updateNode(slug, id, patch),
    removeNode: (id, cascade) => graph.removeNode(slug, id, cascade),

    // --- Edges ---
    addEdge: (edge) => graph.addEdge(slug, edge),
    getEdges: (nodeId, direction, filter) => graph.getEdges(slug, nodeId, direction, filter),
    listAllEdges: () => graph.listAllEdges(slug),
    updateEdge: (id, patch) => graph.updateEdge(slug, id, patch),

    // --- Walk + merge ---
    walkGraph: (startId, opts) => graph.walkGraph(slug, startId, opts),
    mergeNodes: (ids, merged) => graph.mergeNodes(slug, ids, merged),

    // --- Layer promotion ---
    promoteRawToAtomic: (rawId, cfg) => layerPromotion.promoteRawToAtomic(slug, rawId, cfg),
    promoteAtomicToConcept: (atomicIds, name) => layerPromotion.promoteAtomicToConcept(slug, atomicIds, name),
    promoteToSpark: (srcId, sparkData) => layerPromotion.promoteToSpark(slug, srcId, sparkData),
    promoteToProductSpark: (sparkId, productSlug) => layerPromotion.promoteToProductSpark(slug, sparkId, productSlug),
    distillKernel: (nodeIds, opts) => layerPromotion.distillKernel(slug, nodeIds, opts),

    // --- Kernel reads ---
    readKernel: (kernelId) => graph.readKernel(slug, kernelId),
    listKernels: () => graph.listKernels(slug),

    // --- Context Packet ---
    buildContextPacket: (queryId, budget, opts) =>
      contextPacket.buildContextPacket(slug, queryId, budget, opts),

    // --- Entropy reduction ---
    runEntropyReduction: (opts) => entropyReduction.runEntropyReductionCycle(slug, opts),
    onEntropyEvent: (eventName, handler) => entropyReduction.on(eventName, handler),
  });
}

// =====================================================================
// Exports — also re-export raw modules for direct access (tests, IPC).
// =====================================================================

module.exports = {
  getEngine,
  // Raw modules for callers that want surgical access (tests / IPC).
  graph,
  types,
  layerPromotion,
  contextPacket,
  entropyReduction,
  // Constants
  NODE_LAYERS: types.NODE_LAYERS,
  EDGE_TYPES: types.EDGE_TYPES,
  EDGE_STATUSES: types.EDGE_STATUSES,
};
