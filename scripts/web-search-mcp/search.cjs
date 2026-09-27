"use strict"

const { cleanPositiveInteger, cleanString, isObject } = require("./shared.cjs")
const { postWebApi } = require("./api-client.cjs")

function normalizeQuery(value) {
  if (!isObject(value)) return null
  const query = cleanString(value.query)
  if (!query) return null
  return {
    query,
    ...(value.recencyDays != null
      ? { recencyDays: cleanPositiveInteger(value.recencyDays, undefined, 1, 3650) }
      : {}),
    ...(Array.isArray(value.domains)
      ? { domains: value.domains.map(cleanString).filter(Boolean).slice(0, 20) }
      : {}),
    ...(cleanString(value.language) ? { language: cleanString(value.language) } : {}),
  }
}

function normalizeWebSearchInput(argumentsValue) {
  if (!isObject(argumentsValue)) {
    throw new Error("web_search arguments must be an object")
  }
  const rawQueries = Array.isArray(argumentsValue.queries)
    ? argumentsValue.queries
    : [{
        query:
          argumentsValue.query ||
          argumentsValue.q ||
          argumentsValue.search_query ||
          argumentsValue.input,
        recencyDays: argumentsValue.recencyDays,
        domains: argumentsValue.domains,
        language: argumentsValue.language,
      }]
  const queries = rawQueries.map(normalizeQuery).filter(Boolean)
  if (!queries.length) throw new Error("web_search requires a non-empty query")
  return {
    queries,
    limit: cleanPositiveInteger(
      argumentsValue.limit ?? argumentsValue.numResults,
      8,
      1,
      20,
    ),
    ...(argumentsValue.answer === true ? { answer: true } : {}),
    ...(argumentsValue.includeContent === true ? { includeContent: true } : {}),
  }
}

async function executeWebSearch(input, signal) {
  return postWebApi("search", input, signal)
}

module.exports = {
  executeWebSearch,
  normalizeWebSearchInput,
}
