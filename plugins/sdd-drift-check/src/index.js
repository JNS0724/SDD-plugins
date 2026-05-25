const hook = require("./adapters/claude-code/command-hook")

if (require.main === module) {
  hook.main()
}

module.exports = hook
