const Promise = require('bluebird')
const path = require('path')
const S3 = require('aws-sdk/clients/s3')
const SQS = require('aws-sdk/clients/sqs')
const crypto = require('crypto')
const hostname = require('os').hostname()
const instanceId = crypto.createHash('sha1').update(hostname + __dirname).digest('hex') // eslint-disable-line no-path-concat

const bucket = 'jsrtest'

module.exports = ({ accessKeyId, secretAccessKey, region = 'eu-west-1' }) => {
  if (!accessKeyId) {
    throw new Error('The fs store is configured to use aws s3 persistence but the accessKeyId is not set. Use connectionString.persistence.accessKeyId or fs-store-aws-s3-persistence.accessKeyId to set the proper value.')
  }
  if (!secretAccessKey) {
    throw new Error('The fs store is configured to use aws s3 persistence but the accousecretAccessKeyntKey is not set. Use connectionString.persistence.secretAccessKey or fs-store-aws-s3-persistence.secretAccessKey to set the proper value.')
  }

  const s3 = new S3({ accessKeyId: accessKeyId, secretAccessKey: secretAccessKey })
  Promise.promisifyAll(s3)

  const sqs = new SQS({ accessKeyId: accessKeyId, secretAccessKey: secretAccessKey, region })
  Promise.promisifyAll(sqs)

  let queueUrl

  return {
    init: async () => {
      const queueRes = await sqs.createQueueAsync({ QueueName: 'test.fifo', Attributes: { FifoQueue: 'true' } })
      queueUrl = queueRes.QueueUrl
    },
    readdir: async (p) => {
      const res = await s3.listObjectsV2Async({
        Bucket: bucket,
        Prefix: p.replace(/^\//, '')
      })

      const topFilesOrDirectories = res.Contents.map(e => e.Key.replace(p.replace(/^\//, ''), '').split('/').filter(f => f)[0]).filter(f => f)
      return [...new Set(topFilesOrDirectories)]
    },
    readFile: async (p) => {
      const res = await s3.getObjectAsync({
        Bucket: bucket,
        Key: p.replace(/^\//, '')
      })
      return res.Body
    },
    writeFile: (p, c) => s3.putObjectAsync({ Bucket: bucket, Key: p, Body: c }),
    appendFile: async (p, c) => {
      let existingBuffer = Buffer.from([])
      try {
        const res = await s3.getObjectAsync({
          Bucket: bucket,
          Key: p.replace(/^\//, '')
        })
        existingBuffer = res.Body
      } catch (e) {
        // doesn't exists yet
      }

      return s3.putObjectAsync({ Bucket: bucket, Key: p.replace(/^\//, ''), Body: Buffer.concat([existingBuffer, Buffer.from(c)]) })
    },
    rename: async (p, pp) => {
      const objectsToRename = await s3.listObjectsV2Async({
        Bucket: bucket,
        Prefix: p.replace(/^\//, '')
      })
      return Promise.all(objectsToRename.Contents.map(async (e) => {
        const newName = e.Key.replace(p, pp)
        await s3.copyObjectAsync({
          Bucket: bucket,
          CopySource: `/${bucket}/${e.Key}`,
          Key: newName
        })
        await s3.deleteObjectAsync({ Bucket: bucket, Key: e.Key })
      }))
    },
    exists: async (p) => {
      try {
        await s3.headObjectAsync({ Bucket: bucket, Key: p.replace(/^\//, '') })
        return true
      } catch (e) {
        return false
      }
    },
    stat: async (p) => {
      // directory always fail for some reason
      try {
        await s3.headObjectAsync({ Bucket: bucket, Key: p.replace(/^\//, '') })
        return { isDirectory: () => false }
      } catch (e) {
        return { isDirectory: () => true }
      }
    },
    mkdir: (p) => Promise.resolve(),
    remove: async (p) => {
      const blobsToRemove = await s3.listObjectsV2Async({
        Bucket: bucket,
        Prefix: p.replace(/^\//, '')
      })

      return Promise.all(blobsToRemove.Contents.map(e => s3.deleteObjectAsync({ Bucket: bucket, Key: e.Key })))
    },
    path: {
      join: (a, b) => `${a}/${b}`,
      sep: '/',
      basename: path.basename
    },
    lock: async () => {
      const lockId = Date.now()
      const waitForMessage = async () => {
        const res = await sqs.receiveMessageAsync({
          QueueUrl: queueUrl
        })

        if (res.Messages && res.Messages.length) {
          const message = JSON.parse(res.Messages[0].Body)
          if (message.instanceId !== instanceId) {
            await sqs.changeMessageVisibilityAsync({
              QueueUrl: queueUrl,
              ReceiptHandle: res.Messages[0].ReceiptHandle,
              VisibilityTimeout: 0
            })
            return waitForMessage()
          }

          if (message.lockId !== lockId) {
            // orphan message, just remove it
            await sqs.deleteMessageAsync({ QueueUrl: queueUrl, ReceiptHandle: res.Messages[0].ReceiptHandle })
            return waitForMessage()
          }

          return res
        }

        return waitForMessage()
      }

      await sqs.sendMessageAsync({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ instanceId, lockId }),
        MessageGroupId: 'default',
        MessageDeduplicationId: Date.now() + ''
      })

      return waitForMessage()
    },
    releaseLock: (l) => sqs.deleteMessageAsync({ QueueUrl: queueUrl, ReceiptHandle: l.Messages[0].ReceiptHandle })
  }
}