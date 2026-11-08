/** Parses req.body with a zod schema; replaces req.body with the parsed value. */
export const validateBody = (schema) => (req, _res, next) => {
  req.body = schema.parse(req.body ?? {});
  next();
};
