/** Keep host-parsed argument boundaries rather than relying on rawQuotes,
 * which older parsers silently ignore. A quoted name stays one argument. */
export function registerItemSlashCommand({ SlashCommandParser, SlashCommand, SlashCommandArgument }, name, callback, aliases, helpString) {
    return SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name, aliases, helpString,
        splitUnnamedArgument: true,
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'Item name and optional quantity', acceptsMultiple: true })],
        callback: (args, values) => {
            if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) {
                return 'Error: This host cannot preserve item-name argument boundaries. Use the Ledger tab.';
            }
            const command = values.map((value, index) => values.length > 1 && index === values.length - 1 && /^[+\-−]?(?:\d|\.\d|NaN|Infinity)/i.test(value)
                ? value : JSON.stringify(value)).join(' ');
            return callback(args, command);
        },
    }));
}