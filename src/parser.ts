import { LineData, isWindows, readFileAsync, tap } from './helpers';

import { parseString } from 'xml2js';

const minimistString = require('minimist-string');
const os = isWindows() ? 'windows' : 'unix';

export enum Type {
    PASSED = 'passed',
    ERROR = 'error',
    WARNING = 'warning',
    FAILURE = 'failure',
    INCOMPLETE = 'incomplete',
    RISKY = 'risky',
    SKIPPED = 'skipped',
    FAILED = 'failed',
}

export const TypeGroup = new Map<Type, Type>([
    [Type.PASSED, Type.PASSED],
    [Type.ERROR, Type.ERROR],
    [Type.WARNING, Type.SKIPPED],
    [Type.FAILURE, Type.ERROR],
    [Type.INCOMPLETE, Type.INCOMPLETE],
    [Type.RISKY, Type.ERROR],
    [Type.SKIPPED, Type.SKIPPED],
    [Type.FAILED, Type.ERROR],
]);

export const TypeKeys = [Type.PASSED, Type.ERROR, Type.INCOMPLETE, Type.SKIPPED];

export interface Detail {
    file: string;
    line: number;
}

export interface Fault {
    message: string;
    type?: string;
    details?: Detail[];
}

export interface TestCase {
    name: string;
    class: string;
    classname?: string;
    file: string;
    line: number;
    time: number;
    type: Type;
    fault?: Fault;
}

export abstract class Parser {
    abstract parse(content: any): Promise<TestCase[]>;

    abstract parseString(content: string): Promise<TestCase[]>;

    parseFile(fileName: string): Promise<TestCase[]> {
        return readFileAsync(fileName).then((content: string) => this.parseString(content));
    }
}

export class ParserFactory {
    private map = {
        teamcity: TeamCityParser,
        junit: JUnitParser,
    };

    public create(name): Parser {
        name = name.toLowerCase();
        if (!this.map[name]) {
            throw Error('wrong parser');
        }

        return new this.map[name]();
    }
}

export class JUnitParser extends Parser {
    parse(fileName: string): Promise<TestCase[]> {
        return this.parseFile(fileName);
    }

    parseString(content: string): Promise<TestCase[]> {
        return this.xml2json(content).then(json => this.parseTestSuite(json.testsuites));
    }

    private parseTestSuite(testSuitNode: any): TestCase[] {
        let testCase: TestCase[] = [];
        if (testSuitNode.testsuite) {
            testCase = testCase.concat(...testSuitNode.testsuite.map(this.parseTestSuite.bind(this)));
        } else if (testSuitNode.testcase) {
            testCase = testCase.concat(...testSuitNode.testcase.map(this.parseTestCase.bind(this)));
        }

        return testCase;
    }

    private parseTestCase(testCaseNode: any): TestCase {
        const testCaseNodeAttr = testCaseNode.$;

        const testCase: TestCase = {
            name: testCaseNodeAttr.name || null,
            class: testCaseNodeAttr.class,
            classname: testCaseNodeAttr.classname || null,
            file: testCaseNodeAttr.file,
            line: parseInt(testCaseNodeAttr.line || 1, 10) - 1,
            time: parseFloat(testCaseNodeAttr.time || 0),
            type: Type.PASSED,
        };

        const faultNode = this.getFaultNode(testCaseNode);

        if (faultNode === null) {
            return testCase;
        }

        const faultNodeAttr = faultNode.$;
        let message: string = this.parseMessage(faultNode);
        const details: Detail[] = this.parseDetails(message);

        details.forEach((detail: Detail) => {
            message = message.replace(`${detail.file}:${detail.line + 1}`, '').trim();
        });

        return Object.assign(testCase, this.currentFile(details, testCase), {
            type: faultNode.type,
            fault: {
                type: faultNodeAttr.type || '',
                message: message.trim(),
                details: details.filter((detail: Detail) => detail.file !== testCase.file),
            },
        });
    }

    private currentFile(details: Detail[], testCase: TestCase) {
        details = details.filter((detail: Detail) => testCase.file === detail.file);

        return details.length !== 0
            ? details[details.length - 1]
            : {
                  file: testCase.file,
                  line: testCase.line,
              };
    }

    private getFaultNode(testCaseNode: any): any {
        if (testCaseNode.error) {
            return Object.assign(
                {
                    type: this.parseErrorType(testCaseNode.error[0]),
                },
                testCaseNode.error[0]
            );
        }

        if (testCaseNode.warning) {
            return Object.assign(
                {
                    type: Type.WARNING,
                },
                testCaseNode.warning[0]
            );
        }

        if (testCaseNode.failure) {
            return Object.assign(
                {
                    type: Type.FAILURE,
                },
                testCaseNode.failure[0]
            );
        }

        if (testCaseNode.skipped || testCaseNode.incomplete) {
            return {
                type: Type.SKIPPED,
                $: {
                    type: Type.SKIPPED,
                },
                _: '',
            };
        }

        return null;
    }

    private parseMessage(faultNode: any): string {
        return this.crlf2lf(faultNode._);
    }

    private parseDetails(message: string): Detail[] {
        return message
            .split('\n')
            .map(line => line.trim())
            .filter(line => /(.*):(\d+)$/.test(line))
            .map(path => {
                const [, file, line] = path.match(/(.*):(\d+)/);

                return {
                    file,
                    line: parseInt(line, 10) - 1,
                };
            });
    }

    private parseErrorType(errorNode: any): Type {
        const errorType = errorNode.$.type.toLowerCase();

        if (errorType.indexOf(Type.SKIPPED) !== -1) {
            return Type.SKIPPED;
        }

        if (errorType.indexOf(Type.INCOMPLETE) !== -1) {
            return Type.INCOMPLETE;
        }

        if (errorType.indexOf(Type.FAILED) !== -1) {
            return Type.FAILED;
        }

        return Type.ERROR;
    }

    private crlf2lf(str: string): string {
        return str.replace(/\r\n/g, '\n');
    }

    private xml2json(xml: string): Promise<any> {
        return new Promise((resolve, reject) => {
            parseString(xml, (error, json) => {
                return error ? reject(error) : resolve(json);
            });
        });
    }
}

export class TeamCityParser extends Parser {
    private typeMap = {
        testPassed: Type.PASSED,
        testFailed: Type.FAILURE,
        testIgnored: Type.SKIPPED,
    };

    constructor(private lineData = new LineData()) {
        super();
    }

    parse(content: string): Promise<TestCase[]> {
        return this.parseString(content);
    }

    parseString(content: string): Promise<TestCase[]> {
        return [this.convertToArguments, this.groupByType, this.convertToTestCase].reduce((result, method) => {
            return method.call(this, result);
        }, content);
    }

    private convertToTestCase(groups: Array<Array<any>>): Promise<TestCase[]> {
        return Promise.all(
            groups.map(group => {
                if (group.length === 2) {
                    group.splice(1, 0, {
                        type: 'testPassed',
                    });
                }

                const [start, error, finish] = group;
                const [file, className, name] = tap(
                    start.locationHint
                        .trim()
                        .replace(/^php_qn:\/\//, '')
                        .replace('::/', '::')
                        .split('::'),
                    data => (data[0] = this.renamePath(data[0]))
                );

                const type = this.typeMap[error.type];

                const testCase = {
                    name,
                    class: className,
                    classname: null,
                    file,
                    line: 0,
                    time: parseFloat(finish.duration),
                    type,
                };

                if (type === Type.PASSED) {
                    return this.lineData.lineNumber(file, `function ${name}`).then(line => {
                        return tap(testCase, testCase => {
                            testCase.line = line;
                        });
                    });
                }

                const details: Array<Detail> = this.convertToDetail(error.details);
                const detail = details[0] ? details[0] : {};

                return Promise.resolve(
                    Object.assign(testCase, detail, {
                        fault: {
                            message: error.message,
                            details: details.filter(detail => detail.file !== file),
                        },
                    })
                );
            })
        );
    }

    private convertToDetail(content: string): Array<Detail> {
        return content
            .split('|n')
            .map(line => line.trim())
            .filter(line => !!line)
            .map(path => {
                const [, file, line] = path.match(/(.*):(\d+)/);

                return {
                    file: this.renamePath(file),
                    line: parseInt(line, 10),
                };
            });
    }

    private groupByType(items: Array<any>): Array<Array<any>> {
        let counter = 0;
        return items.reduce((results, item) => {
            if (!results[counter]) {
                results[counter] = [];
            }
            results[counter].push(item);

            if (item.type === 'testFinished') {
                counter++;
            }

            return results;
        }, []);
    }

    private convertToArguments(content: string): Array<string> {
        return content
            .split(/\r|\n/)
            .filter(line => /^##teamcity/.test(line))
            .map(line => {
                line = line
                    .trim()
                    .replace(/^##teamcity\[|\]$/g, '')
                    .replace(/\\/g, '/');

                const argv: Array<string> = minimistString(line)._;
                const type: string = argv.shift();

                return argv.reduce(
                    (options, arg) => {
                        return tap(options, opts => {
                            const [key, value] = arg.split('=');
                            opts[key] = value;
                        });
                    },
                    {
                        type,
                    }
                );
            })
            .filter(item => ['testCount', 'testSuiteStarted', 'testSuiteFinished'].indexOf(item.type) === -1);
    }

    private renamePath(path: string) {
        return os === 'windows' ? path.replace(/\//g, '\\') : path;
    }
}
