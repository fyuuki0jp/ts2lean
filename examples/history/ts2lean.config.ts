export default {
  bindings: [
    {module:"history.ts", export:"createHistory", spec:"History.lean", contract:"History.create"},
    {module:"history.ts", export:"transitionHistory", spec:"History.lean", contract:"History.bounded"},
  ],
};
