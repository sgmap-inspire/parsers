'use strict'

const sax = require('sax')
const isPlainObject = require('is-plain-obj')
const Writable = require('readable-stream/writable')
const bundledSchema = require('../bundled-schema.json')

function strRight(str, separator) {
  const position = str.indexOf(separator)
  if (position) {
    return str.slice(position + 1)
  }
  return str
}

function plainObjectForEach(obj, iteratee) {
  if (!isPlainObject(obj)) {
    throw new Error('plainObjectForEach must be called with an plain object')
  }
  Object.keys(obj).forEach(key => iteratee(obj[key], key, obj))
}

function isAcceptableValue(value) {
  return value && (!isPlainObject(value) || Object.keys(value).length !== 0)
}

function parseDate(textValue) {
  if (textValue.length === 19) {
    return new Date(textValue + 'Z')
  }
  return new Date(textValue)
}

function makeValue(textValue, definition) {
  if (definition.type === 'integer') {
    return parseInt(textValue, 10)
  }
  if (definition.type === 'number') {
    return parseFloat(textValue)
  }
  if (definition.type === 'date') {
    return parseDate(textValue)
  }
  return textValue
}

class Context {
  constructor(parser, options) {
    if (!parser || !options.elementName || !options.onClose || !options.definition) {
      throw new Error('At least one required param is missing')
    }

    this.parser = parser
    this.elementName = options.elementName
    this.onClose = options.onClose
    this.definition = options.definition

    if (this.definition.type === 'object') {
      this.internalValue = {}
    }

    if (this.definition.from === 'text' || this.definition.fallbackText || this.definition.extractText) {
      this.parser.toggleTextCapture(true)
    }

    if (options.attributes) {
      this.processAttributes(options.attributes)
    }
  }

  processAttributes(attrs) {
    if (this.definition.from === 'attributes') {
      this.internalValue = makeValue(attrs[this.definition.attribute], this.definition)
    }
    if (this.definition.attributes) {
      plainObjectForEach(attrs, (value, attrName) => {
        if (attrName in this.definition.attributes) {
          const attributeDefinition = this.definition.attributes[attrName]
          const targetAttrName = attributeDefinition.renameTo ? attributeDefinition.renameTo : attrName
          this.internalValue[targetAttrName] = makeValue(value, attributeDefinition)
        }
      })
    }
  }

  // When opening element is a declared property of parent object
  isAcceptableProperty(name) {
    return this.definition.properties && name in this.definition.properties
  }

  // When opening element is an acceptable value for the current property
  isAcceptablePropertyType(name) {
    return this.definition.accept && this.definition.accept.includes(name)
  }

  // When opening element is an acceptable value for the parent container
  isAcceptableContentChild(name) {
    return this.definition.acceptedChildren && this.definition.acceptedChildren.includes(name)
  }

  // When opening element is an acceptable child element for the current object
  isAcceptableChild(name) {
    return this.definition.children && name in this.definition.children
  }

  identifyChildElement(name) {
    if (this.isAcceptableChild(name)) {
      return 'child'
    }
    if (this.isAcceptableContentChild(name)) {
      return 'contentChild'
    }
    if (this.isAcceptablePropertyType(name)) {
      return 'propertyType'
    }
    if (this.isAcceptableProperty(name)) {
      return 'property'
    }
  }

  onOpenTag(elementName, attributes) {
    const childElementType = this.identifyChildElement(elementName)
    if (!childElementType) {
      return
    }

    this.parser.toggleTextCapture(false)

    const isProperty = childElementType === 'property'
    const element = isProperty ? this.elementName : elementName

    const childDefinition = isProperty ?
      this.parser.getPropertyDefinition(this.elementName, elementName) :
      this.parser.getElementDefinition(elementName)

    this.parser.pushContext({
      elementName,
      attributes,
      definition: childDefinition,
      onClose: value => {
        if (!isAcceptableValue(value)) {
          return
        }
        if (['child', 'property'].indexOf(childElementType) > -1) {
          const definition = isProperty ? childDefinition : this.parser.getChildElementPropertyDefinition(this.elementName, elementName)
          this.addPropertyValue(definition.renameTo ? definition.renameTo : elementName, makeValue(value, definition), definition.array)
        } else if (childElementType === 'propertyType') {
          this.setValue(makeValue(value, this.definition))
        } else {
          this.addValue(element, makeValue(value, this.definition))
        }
      }
    })
  }

  addValue(elementName, value) {
    if (!this.internalValue.children) {
      this.internalValue.children = []
    }
    value['@elementType'] = elementName
    this.internalValue.children.push(value)
  }

  addPropertyValue(propertyName, value, arrayMode) {
    if (arrayMode) {
      if (this.internalValue[propertyName]) {
        this.internalValue[propertyName].push(value)
      } else {
        this.internalValue[propertyName] = [value]
      }
    } else {
      this.internalValue[propertyName] = value
    }
  }

  setValue(value) {
    this.internalValue = value
  }

  isInTextMode() {
    return this.parser.capturingText && !this.internalValue
  }

  isExtractingText() {
    return this.definition.extractText && this.parser.capturingText
  }

  close() {
    let textValue
    if (this.isExtractingText()) {
      textValue = this.parser.flushTextBuffer()
      this.addPropertyValue(this.definition.extractText.key, makeValue(textValue, this.definition.extractText))
    } else if (this.isInTextMode()) {
      textValue = this.parser.flushTextBuffer()
      this.setValue(isAcceptableValue(textValue) && makeValue(textValue, this.definition))
    }
    this.onClose(this.internalValue)
  }
}

class Parser extends Writable {
  constructor() {
    super()
    this.definition = bundledSchema
    this.acceptableRootElements = Object.keys(this.definition)

    this.elementStack = []
    this.contextStack = []

    this.parser = sax.createStream(true, {trim: true, strictEntities: true})
    this.parser.on('opentag', e => this.onOpenTag(e.name, e.attributes))
    this.parser.on('closetag', name => this.onCloseTag(name))
    this.parser.on('text', text => this.onText(text))
    this.parser.on('error', err => this.emit('error', err))
    this.parser.on('end', () => this.emit('end'))

    this.once('finish', () => this.parser.end())
  }

  getElementDefinition(elementName) {
    return this.definition[elementName]
  }

  getPropertyDefinition(elementName, propertyName) {
    return this.getElementDefinition(elementName).properties[propertyName]
  }

  getChildElementPropertyDefinition(elementName, childElementProperty) {
    return this.getElementDefinition(elementName).children[childElementProperty]
  }

  get currentPosition() {
    return this.elementStack.length
  }

  pushContext(options) {
    this.contextStack.push({
      context: new Context(this, options),
      position: this.currentPosition - 1
    })
  }

  hasContext() {
    return this.contextStack.length > 0
  }

  get currentContext() {
    return this.contextStack[this.contextStack.length - 1].context
  }

  get currentContextPosition() {
    return this.contextStack[this.contextStack.length - 1].position
  }

  popContext() {
    this.currentContext.close()
    return this.contextStack.pop()
  }

  isAtRoot() {
    return this.elementStack.length === 1
  }

  onResult(name, value) {
    this.emit('result', {type: name, body: value})
  }

  /* Text capture */

  toggleTextCapture(targetMode) {
    if ((this.capturingText && !targetMode) || (targetMode && !this.capturingText)) {
      this.capturingText = targetMode
      this.textBuffer = ''
    }
  }

  bufferText(text) {
    if (!this.capturingText) {
      return
    }
    this.textBuffer = this.textBuffer + text.trim()
  }

  flushTextBuffer() {
    if (!this.capturingText) {
      return
    }
    const buffer = this.textBuffer
    this.toggleTextCapture(false)
    return buffer
  }

  /* XML stream handlers */

  onOpenTag(name, attributes) {
    name = strRight(name, ':')
    this.elementStack.push(name)
    if (this.isAtRoot() && !this.hasContext() && this.acceptableRootElements.indexOf(name) > -1) {
      this.pushContext({
        elementName: name,
        attributes,
        definition: this.definition[name],
        onClose: value => this.onResult(name, value)
      })
    } else if (this.hasContext()) {
      this.currentContext.onOpenTag(name, attributes)
    }
  }

  onCloseTag() {
    this.elementStack.pop()
    if (!this.hasContext()) {
      return
    }
    if (this.currentContextPosition === this.currentPosition) {
      this.popContext()
    }
  }

  onText(text) {
    this.bufferText(text)
  }

  /* Writeable stream methods */

  _write(chunk, encoding, callback) {
    this.parser.write(chunk)
    callback()
  }
}

module.exports = Parser
