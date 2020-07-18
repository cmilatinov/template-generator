#!/usr/bin/env node

const commandLineArgs = require('command-line-args');
const prompts = require('prompts');
const randomString = require('crypto-random-string');
const axios = require('axios');
const ProgressBar = require('progress');
const fs = require('fs');
const path = require('path');
const extract = require('./extract');
const replaceInFile = require('replace-in-file');
const npm = require('npm');

require('colors');

// Get command arguments
const args = commandLineArgs([
    { name: 'template', alias: 't', type: String }
]);

// Current working directory of script
const dir = process.cwd();

// Import template list
const templates = require('./templates.json');

// Find template to use
let template = templates.find(t => t.name === args.template);
if (!template) {
    console.log(`Template '${args.template}' does not exist.`.brightRed);
    process.exit();
}

// Ask user for necessary inputs
populateVariables(template)
    .then(async variables => {

        const templateRootPath = path.join(dir, variables.APP_NAME);

        let res = await axios.get(template.repository.replace('https://github.com', 'https://api.github.com/repos'));
        let totalLength = res.data.size;
        console.log(`downloading ${template.repository}`);

        const { data } = await axios.get(`${template.repository}/archive/master.zip`, { responseType: 'stream' });

        const downloadBar = new ProgressBar('└─> [:bar] :ratekbps :percent :etas', {
            width: 30,
            complete: '=',
            incomplete: ' ',
            renderThrottle: 1,
            total: totalLength
        });

        data.on('data', chunk => {
            if (!downloadBar.complete)
                downloadBar.tick(chunk.length / 1024);
        });

        data.on('end', _ => {
            console.log(`\nextracting into ${dir}\\${variables.APP_NAME}`);

            const extractBar = new ProgressBar('└─> [:bar] :ratekbps :percent :elapseds', {
                width: 30,
                complete: '=',
                incomplete: ' ',
                renderThrottle: 1,
                total: totalLength
            });

            fs.createReadStream(path.join(dir, 'archive.zip'))
                .pipe(extract({ path: templateRootPath }))
                .on('entry', entry => {
                    if (!extractBar.complete)
                        extractBar.tick(entry.vars.uncompressedSize / 1024);
                })
                .on('finish', _ => {
                    fs.unlinkSync(path.join(dir, 'archive.zip'));
                    console.log('\nadjusting template...');
                    replaceInTemplate(variables, templateRootPath)
                        .then(_ => {
                            console.log('\ncreating directories...');
                            createdirs(templateRootPath, template.create_directories);
                            console.log('\ninstalling dependencies...\n');
                            installDependencies(templateRootPath, template.extra_dependencies.map(d => replaceInString(variables, d)))
                                .then(_ => {
                                    console.log(`\n\nTemplate '${variables.APP_NAME}' was succesfully created.`.brightGreen);
                                    process.exit();
                                })
                                .catch(_ => {
                                    console.log(`An error has occurred when attempting install dependencies.`.brightRed);
                                    process.exit();
                                });
                        });
                })
                .on('error', _ => {
                    fs.unlinkSync(path.join(dir, 'archive.zip'));
                    console.log(`\nAn error has occurred when attempting to generate the template.`.brightRed);
                });

        });

        const writer = fs.createWriteStream(path.join(dir, 'archive.zip'));
        data.pipe(writer);

    })
    .catch(_ => {
        console.log(`An error has occurred when attempting to generate the template.`.brightRed);
        process.exit();
    });

async function populateVariables(template) {

    let variables = {};

    // Loop for each var
    for (let v of template.variables) {

        // If this is a prompt var, run prompt and store the result in variables
        if (v.prompt) {

            let result = await prompts({
                type: v.type || 'text',
                name: v.name,
                message: replaceInString(variables, v.prompt),
                initial: v.type === 'select' ? v.options.indexOf(v.default) || 0 : replaceInString(variables, v.default),
                choices: v.options ? v.options.map(s => ({ title: s, value: s })) : [],
                validate: value => ((v.required && !!value) || !v.required)
            });

            Object.assign(variables, result);

        // If this is a generated var, generate it
        } else if (v.generate) {
            variables[v.name] = randomString({ type: v.generate, length: v.length || 30 });
        }

    }

    console.log();

    return variables;

}

function replaceInString(variables, str) {
    if (!str)
        return '';

    if (typeof str !== 'string')
        return str;

    let regex = /{{\s*([a-zA-Z_]+)\s*}}/g;
    return str.replace(regex, (_, v) => (variables[v] || ''));
}

function replaceInTemplate(variables, path) {
    let keys = Object.keys(variables);
    return replaceInFile({
        files: `${path}/**`,
        from: keys.map(k => new RegExp(`{{\\s*${k}\\s*}}`, 'g')),
        to: keys.map(k => variables[k])
    });
}

function createdirs(rootPath, dirs) {
    dirs.forEach(d => {
        try {
            fs.mkdirSync(path.join(rootPath, d), { recursive: true })
        } catch {
            console.log(`Failed to create directory '/${d}'`.brightYellow);
        }
    });
}

function installDependencies(path, dependencies) {
    return new Promise((resolve, reject) => {
        npm.load(err => {
            if (err)
                return reject(err);

            npm.commands.install(path, [], err => {
                if (err)
                    return reject(err);

                npm.commands.install(path, dependencies, err => {
                    if (err)
                        return reject(err);

                    resolve();
                });
            });
        });
    });
}



