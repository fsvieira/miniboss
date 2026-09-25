function getMaxIterations() {
  const parsed = parseInt(process.env.MAX_ITERATIONS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
}

module.exports = { getMaxIterations };
