'use strict';
const handleRequest = require('../server');

module.exports = (req, res) => {
  return handleRequest(req, res);
};
