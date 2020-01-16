"use strict";

const parserHelpers = require('./utils/parserHelpers')
const fs = require('fs')
const parser = require('solidity-parser-diligence')
const { linearize } = require('c3-linearization')
const treeify = require('treeify')
const importer = require('../lib/utils/importer')


export function ftrace(functionId, accepted_visibility, files, options = {}, noColorOutput = false) {
  if (files.length === 0) {
    return 'No files were specified for analysis in the arguments. Bailing...'
  }

  const [contractToTraverse, functionToTraverse] = functionId.split('::', 2)

  if (contractToTraverse === undefined || functionToTraverse === undefined) {
    return 'You did not provide the function identifier in the right format "CONTRACT::FUNCTION"'
  }

  if (accepted_visibility !== 'all' && accepted_visibility !== 'internal' && accepted_visibility !== 'external') {
    return `The "${accepted_visibility}" type of call to traverse is not known [all|internal|external]`
  }

  let functionCallsTree = {}

  // initialize vars that persist over file parsing loops
  let userDefinedStateVars = {}
  let stateVars = {}
  let dependencies = {}

  let functionsPerContract = {}
  let contractUsingFor = {}
  let contractNames = new Array()

  let modifiers = {}
  let functionDecorators = {}

  let fileASTs = new Array()
  let contractASTIndex = {}

  // make the files array unique by typecastign them to a Set and back
  // this is not needed in case the importer flag is on, because the 
  // importer module already filters the array internally
  if(options.importer) {
    files = importer.importProfiler(files)
  } else {
    files = [...new Set(files)];
  }

  for (let file of files) {

    let content
    try {
      content = fs.readFileSync(file).toString('utf-8')
    } catch (e) {
      if (e.code === 'EISDIR') {
        console.error(`Skipping directory ${file}`)
        continue
      } else throw e;
    }

    const ast = parser.parse(content)

    fileASTs.push(ast)

    let contractName = null

    parser.visit(ast, {
      ContractDefinition(node) {
        contractName = node.name
        contractNames.push(contractName)
        
        let kind=""
        if (node.kind=="interface"){
          kind="  (iface)"
        } else if(node.kind=="library"){
          kind="  (lib)"
        }

        userDefinedStateVars[contractName] = {}
        stateVars[contractName] = {}
        functionsPerContract[contractName] = new Array()
        contractUsingFor[contractName] = {}

        contractASTIndex[contractName] = fileASTs.length - 1

        dependencies[contractName] = node.baseContracts.map(spec =>
          spec.baseName.namePath
        )
      },

      StateVariableDeclaration(node) {
        for (let variable of node.variables) {
          if (parserHelpers.isUserDefinedDeclaration(variable)) {
            userDefinedStateVars[contractName][variable.name] = variable.typeName.namePath
          } else if (parserHelpers.isElementaryTypeDeclaration(variable)) {
            stateVars[contractName][variable.name] = variable.typeName.name
          } else if (parserHelpers.isArrayDeclaration(variable)) {
            stateVars[contractName][variable.name] = variable.typeName.baseTypeName.namePath
          } else if (parserHelpers.isMappingDeclaration(variable)) {
            stateVars[contractName][variable.name] = variable.typeName.valueType.name
          }
        }
      },

      FunctionDefinition(node) {
        functionsPerContract[contractName].push(node.name)
      },

      UsingForDeclaration(node) {
        contractUsingFor[contractName][node.typeName.name] = node.libraryName
      }
    })
  }

  dependencies = linearize(dependencies, {reverse: true})

  for (let ast of fileASTs) {
    constructPerFileFunctionCallTree(ast)
  }
  // END of file traversing

  let touched = {}
  let callTree = {}

  if(!functionCallsTree.hasOwnProperty(contractToTraverse)) {
    return `The ${contractToTraverse} contract is not present in the codebase.`
  } else if (!functionCallsTree[contractToTraverse].hasOwnProperty(functionToTraverse)) {
    return `The ${functionToTraverse} function is not present in ${contractToTraverse}.`
  }

  const seedKeyString = `${contractToTraverse}::${functionToTraverse}`
  touched[seedKeyString] = true
  callTree[seedKeyString] = {}

  // Call with seed
  constructCallTree(contractToTraverse, functionToTraverse, callTree[seedKeyString])

  return treeify.asTree(callTree, true)


  /****************************
   * 
   * INTERNAL FUNCTIONS BLOCK
   * 
   ****************************/

  function modifierCalls(modifierName, contractName) {
    if (dependencies.hasOwnProperty(contractName)) {
      for (let dep of dependencies[contractName]) {
        if (functionCallsTree[dep].hasOwnProperty(modifierName)) {
          return functionCallsTree[dep][modifierName]
        }
      }
    }

    return functionCallsTree[contractName].hasOwnProperty(modifierName) ?
            functionCallsTree[contractName][modifierName] : {}
  }

  function constructPerFileFunctionCallTree(ast) {
    let contractName = null
    let functionName = null

    let userDefinedLocalVars = {}
    let localVars = {}
    let tempUserDefinedStateVars = {}
    let tempStateVars = {}

    parser.visit(ast, {
      ContractDefinition(node) {
        contractName = node.name

        functionCallsTree[contractName] = {}
        modifiers[contractName] = {}

        for (let dep of dependencies[contractName]) {
          Object.assign(tempUserDefinedStateVars, userDefinedStateVars[dep])
          Object.assign(tempStateVars, stateVars[dep])
        }

        Object.assign(tempUserDefinedStateVars, userDefinedStateVars[contractName])
        Object.assign(tempStateVars, stateVars[contractName])
      },

      'ContractDefinition:exit': function(node) {
        contractName = null 
        tempUserDefinedStateVars = {}
        tempStateVars = {}
      },

      FunctionDefinition(node) {
        if (node.isConstructor) {
          functionName = '<Constructor>'
        } else if (node.isFallback) {
          functionName = '<Fallback>'
        } else if (node.isReceiveEther) {
          functionName = '<Receive Ether>'
        } else {
          functionName = node.name
        }


        let spec = ''
        if (node.visibility === 'public' || node.visibility === 'default') {
          spec += '[Pub] ❗️'
        } else if (node.visibility === 'external') {
          spec += '[Ext] ❗️'
        } else if (node.visibility === 'private') {
          spec += '[Priv] 🔐'
        } else if (node.visibility === 'internal') {
          spec += '[Int] 🔒'
        }

        let payable = ''
        if (node.stateMutability === 'payable') {
          payable = '💵'
        }

        let mutating = ''
        if (!node.stateMutability) {
          mutating = '🛑'
        }

        functionDecorators[functionName] = ` | ${spec}  ${mutating} ${payable}`

        functionCallsTree[contractName][functionName] = {}
        modifiers[contractName][functionName] = new Array()
      },

      'FunctionDefinition:exit': function(node) {
        functionName = null 
        userDefinedLocalVars = {}
        localVars = {}
      },

      ModifierDefinition(node) {
        functionName = node.name, contractName
      },

      'ModifierDefinition:exit': function(node) {
        functionName = null
      },

      ModifierInvocation(node) {
        modifiers[contractName][functionName].push(node.name)
      },

      ParameterList(node) {
        for (let parameter of node.parameters) {
          if (parameter.name === null) {
            return
          } else if (parserHelpers.isUserDefinedDeclaration(parameter)) {
            userDefinedLocalVars[parameter.name] = parameter.typeName.namePath
          } else if (functionName) {
            localVars[parameter.name] = parameter.typeName.name
          }
        }
      },

      VariableDeclaration(node) {
        if (functionName && node.name === null) {
          return
        } else if (functionName && parserHelpers.isUserDefinedDeclaration(node)) {
          userDefinedLocalVars[node.name] = node.typeName.namePath
        } else if (functionName && parserHelpers.isElementaryTypeDeclaration(node)) {
          localVars[node.name] = node.typeName.name
        } else if (functionName && parserHelpers.isArrayDeclaration(node)) {
          localVars[node.name] = node.typeName.baseTypeName.namePath
        } else if (functionName && parserHelpers.isMappingDeclaration(node)) {
          localVars[node.name] = node.typeName.valueType.name
        }
      },

      FunctionCall(node) {
        if (!functionName) {
          // this is a function call outside of functions and modifiers, ignore if exists
          return
        }

        const expr = node.expression

        let name
        let localContractName
        let visibility

        // The following block is a nested switch statement for creation of the call tree
        // START BLOCK
        if(
          parserHelpers.isRegularFunctionCall(node, contractNames) &&
          functionsPerContract[contractName].includes(expr.name)
        ) {
          name = expr.name

          localContractName = contractName

          // check if function is implemented in this contract or in any of its dependencies
          if (dependencies.hasOwnProperty(contractName)) {
            for (let dep of dependencies[contractName]) {
              if (!functionCallsTree.hasOwnProperty(dep)) {
                constructPerFileFunctionCallTree(fileASTs[contractASTIndex[dep]])
              }

              if(!functionCallsTree.hasOwnProperty(dep)) {
                throw new Error(`
A referenced contract was not available in the provided list of contracts. This usually means that some imported file was left out of the files argument.
You can try to solve this automatically by using the '-i' flag or by including all the imported files manually.
`)
              }

              if (functionCallsTree[dep].hasOwnProperty(name)) {
                localContractName = dep
              }
            }
          }

          visibility = 'internal'
        } else if (parserHelpers.isMemberAccess(node)) {
          let object = null
          let variableType = null

          visibility = 'external'
          
          name = expr.memberName

          
          // checking if the member expression is a simple identifier
          if(expr.expression.hasOwnProperty('name')) {
            object = expr.expression.name

          // checking if it is a member of `address` and pass along it's contents
          } else if(parserHelpers.isMemberAccessOfAddress(node)) {
            if(expr.expression.arguments[0].hasOwnProperty('name')) {
              object = expr.expression.arguments[0].name
            } else if(expr.expression.arguments[0].type === 'NumberLiteral') {
              object = 'address('+expr.expression.arguments[0].number+')'
            } else {
              object = JSON.stringify(expr.expression.arguments).replace(/"/g,"")
            }

          // checking if it is a typecasting to a user-defined contract type
          } else if(parserHelpers.isAContractTypecast(node, contractNames)) {
            object = expr.expression.expression.name
          }

          // check if member expression is a special var and get its canonical type
          if(parserHelpers.isSpecialVariable(expr.expression)) {
            variableType = parserHelpers.getSpecialVariableType(expr.expression)

          // check if member expression is a typecast for a canonical type
          } else if(parserHelpers.isElementaryTypecast(expr.expression)) {
            variableType = expr.expression.expression.typeName.name

          // else check for vars in defined the contract
          } else {
            // check if member access is a function of a "using for" declaration
            // START
            if(localVars.hasOwnProperty(object)) {
              variableType = localVars[object]
            } else if(userDefinedLocalVars.hasOwnProperty(object)) {
              variableType = userDefinedLocalVars[object]
            } else if(tempUserDefinedStateVars.hasOwnProperty(object)) {
              variableType = tempUserDefinedStateVars[object]
            } else if(tempStateVars.hasOwnProperty(object)) {
              variableType = tempStateVars[object]
            }
          }

          // convert to canonical elementary type: uint -> uint256
          variableType = variableType === 'uint' ? 'uint256' : variableType

          // if variable type is not null let's replace "object" for the actual library name
          if(
            variableType !== null &&
            contractUsingFor[contractName].hasOwnProperty(variableType) &&
            functionsPerContract
              .hasOwnProperty(contractUsingFor[contractName][variableType]) &&
            functionsPerContract[
              contractUsingFor[contractName][variableType]
            ].includes(name)
          ) {
            if(!options.libraries) {
              object = contractUsingFor[contractName][variableType]
            } else {
              return
            }
          }
          // END

          // if we have found nothing so far then create no node
          if(object === null) {
            return
          } else if(object === 'this') {
            opts.color = colorScheme.call.this
          } else if (object === 'super') {
            // "super" in this context is gonna be the 2nd element of the dependencies array
            // since the first is the contract itself
            localContractName = dependencies[localContractName][1]
          } else if (tempUserDefinedStateVars[object] !== undefined) {
            localContractName = tempUserDefinedStateVars[object]
          } else if (userDefinedLocalVars[object] !== undefined) {
            localContractName = userDefinedLocalVars[object]
          } else {
            localContractName = object
          }

        } else {
          return
        }

        if(!functionCallsTree[contractName][functionName].hasOwnProperty(name)) {
          functionCallsTree[contractName][functionName][name] = {
            contract: localContractName,
            numberOfCalls: 1,
            visibility: visibility
          }
        } else {
          functionCallsTree[contractName][functionName][name].numberOfCalls++
        }
      }
    })
  }

  // Function to recursively generate the tree to show in the console
  function constructCallTree(reduceJobContractName, reduceJobFunctionName, parentObject) {
    let tempIterable

    if (functionCallsTree[reduceJobContractName][reduceJobFunctionName] === undefined) {
      return
    }

    tempIterable = functionCallsTree[reduceJobContractName][reduceJobFunctionName]

    for (const modifier of modifiers[reduceJobContractName][reduceJobFunctionName]) {
      Object.assign(tempIterable, modifierCalls(modifier, reduceJobContractName))
    }

    Object.entries(tempIterable).forEach(([functionCallName, functionCallObject]) => {

      if (
        functionCallName !== 'undefined' && (
          accepted_visibility == 'all' ||
          functionCallObject.visibility == accepted_visibility
        )
      ) {
        let keyString = `${functionCallObject.contract}::${functionCallName}`

        keyString += functionDecorators[functionCallName] === undefined ? '' : functionDecorators[functionCallName]

        if(!noColorOutput && functionCallObject.visibility === 'external' && accepted_visibility !== 'external') {
          keyString = keyString.yellow
        }

        if(touched[keyString] === undefined) {
          parentObject[keyString] = {}
          touched[keyString] = true

          // Test if the call is really to a contract or rather an address variable member access
          // If it is not a contract we should stop here
          if(functionCallObject.contract.substring(0,8) !== '#address') {
            constructCallTree(functionCallObject.contract, functionCallName, parentObject[keyString])
          }
        } else {
          parentObject[keyString] = Object.keys(functionCallsTree[functionCallObject.contract][functionCallName]).length === 0 ?
                                      {} :
                                      noColorOutput ?
                                        '..[Repeated Ref]..' :
                                        '..[Repeated Ref]..'.red
        }
      }
    })
  }

}