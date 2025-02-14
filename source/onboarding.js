const { Pool } = require('pg')
const got = require('got')

const INTERVAL = 5000
const MILLISECONDS_BEFORE_OFFERING_HELP = 30000
const MILLISECONDS_BEFORE_KICK_WARNING = 360000
const MILLISECONDS_BEFORE_KICKING = 540000
const WELCOME_PREFIX = '👋welcome-'
const { 
  ONBOARDING_CATEGORY_ID,
  UNLOCKED_INTRODUCTIONS_CHANNEL_ROLE_ID,
  EVERYONE_ROLE_ID,
  PRO_ROLE_ID,
  REGULAR_MEMBER_ROLE_ID,
  PG_URI,
  CONVERT_KIT_API_KEY,
  CONVERT_KIT_API_SECRET,
  CONVERT_KIT_TAG_ID,
  CONVERT_KIT_FORM_ID
} = process.env

module.exports = bot => {

  const steps = [
    {
      question: `Meow! Welcome to the Scrimba community! 

I am Scrimba's mascot, Pumpkin, and I am here to lend you a helping paw in joining Scrimba Discord community.

Right now, you can only see a couple of channels 😢. 

There are *tonne* more to see, which I will unlock for you once you answer some questsions.

First, **what is your first name?**`,
      help: `it's been a minute, and I still don't know your name 👉🥺👈.

Write your first name below and press ENTER to continue.`,
      validate: answer => {
        if (answer.includes(' ')) {
          return `you wrote "${answer}" but that answer includes a space. What is your *first* name, please?`
        }
      },
      process: async (answer, member) => await member.setNickname(answer),
      successMessage: "ℹ️  Nice to meet youu"
    }, 
    {
      question: `I couldn't help but notice you don't have a profile picture. 

Please take a moment to set a Discord profile picture - it makes the communication feel more personal.

I will automatically detect when you've set a profile picture then send you the next step.`,
      attachment: './source/assets/avatar_example.png',
      help: "**Please take a moment to set a Discord profile piture**. Not sure how? Check out this article, https://www.businessinsider.com/how-to-change-discord-picture?r=US&IR=T",
      shouldSkip: member => member.user.avatar,
      process: async (answer, member, channel) => {
        await disableInput(channel, member.id)
        return new Promise(resolve => {
          const interval = setInterval(async () => {
            if (member.user.avatar) {
              await enableInput(channel, member.id)
              resolve()
              clearInterval(interval)
            }
          }, 1000)
        })
      },
      processImmediately: true
    },
    {
      question: `Next, please take a moment to connect your Scrimba and Discord accounts: https://scrimba.com/discord/connect

I will automatically detect when you click **Authorize** then send you the next step.`,
      shouldSkip: async member => {
        return await findScrimbaUserByDiscordId(member.user.id)
      },
      help: `**Please take a moment to connect your Scrimba and Discord account**.

If you don't have a Scrimba account yet, create a free account here: https://scrimba.com. 

If you clicked **Authorize** but nothing happened, please ensure you are not logged in to a different Discord account in your web browser.`,
      successMessage: 'Fantastik!',
      process: (answer, member, channel) => fetchScrimbaUser(member.id, channel),
      processImmediately: true,
    },
    {
      question: `Please watch this welcome video then click the ✅ emoji beneath to move on to the final step.

   https://youtu.be/lPIi430q5fk`,
      expectedReaction: '✅',
      successMessage: 'ℹ️ Great!'
    },
    {
      question: `I just unlocked a channel called #introduce-yourself for you. Do you see it?

We ask all new members to introduce themselves. You can read about other new members then please write your own introduction! 

You can introduce yourself any way you like but here's a template to make it easy. Just replace the \`...\` bits with your own information:

\`\`\`
Hello 👋

My name is ... and I am from ...!

I am currently working/unemployed/studying at ...

When I am not coding, I enjoy ....

Looking forward to become a part of this epic/awesome/friendly community 🤩 🙏
\`\`\`
Once you've done that, come back here and click the ✅ emoji beneath to unlock the whole server.`,
      shouldSkip: async member => { 
        // here we use shouldSkip like a preprocessor. You
        // can think of it like a `beforeStepRun` hook
        await member.roles.add(UNLOCKED_INTRODUCTIONS_CHANNEL_ROLE_ID)
        return false
      },
      expectedReaction: '✅'
    }
  ]

  const pool = new Pool({
    connectionString: PG_URI
  })

  const extractOnboardeeIdFromChannelName = channelName =>
    channelName.match(/_([^_]+$)/)[1]

  const getOnboardeeFromChannel = async channel => {
    const guild = bot.guilds.cache.first()
    const onboardeeId = extractOnboardeeIdFromChannelName(channel.name)
    await guild.members.fetch()
    const onboardee = guild
      .members
      .cache
      .find(member => member.id === onboardeeId)
    return onboardee
  }

  const cleanup = async () => {
    bot
      .channels
      .cache
      .filter(channel => channel.name?.startsWith(WELCOME_PREFIX))
      .forEach(async channel => {
        const member = await getOnboardeeFromChannel(channel)
        if (!member) {
          // Onboardee left while the bot was
          // offline/restarting so adiós!
          await cleanupChannel(channel)
          return
        }
        const { step, index } = await findCurrentStep(channel)
        if(step.processImmediately) {
          await processAnswer(step, index, channel, member, '')
        }
      })
  }

  bot.on('ready', async () => {
    await cleanup()
    setInterval(() => {
      bot
        .channels
        .cache
        .filter(channel => channel.name?.startsWith(WELCOME_PREFIX))
        .forEach(offerHelpOrKick)
    }, INTERVAL)
  })

  bot.on('guildMemberRemove', async member => {
    const channel = bot
      .channels
      .cache
      .find(channel => channel.name?.startsWith(WELCOME_PREFIX) && extractOnboardeeIdFromChannelName(channel.name) === member.id)
    if (channel) {
      await cleanupChannel(channel)
    }
  })

  bot.on('guildMemberAdd', async member => {
    const channel = await member
      .guild
      .channels
      .create(`${WELCOME_PREFIX}${member.user.username}_${member.user.id}`, {
        parent: ONBOARDING_CATEGORY_ID,
        permissionOverwrites: [
          {
            id: member.id,
            allow: ['VIEW_CHANNEL']
          },
          {
            id: EVERYONE_ROLE_ID,
            deny: ['VIEW_CHANNEL']
          },
          {
            id: bot.user.id,
            allow: ['VIEW_CHANNEL']
          }
        ]
      })

    const firstStep = steps[0]
    try {
      await channel.send(firstStep.question)
    } catch (error) {
      console.error("error onGuildMemberAdd", error)
    }
  })

  const findCurrentStep = async channel => {
    const messages = await channel.messages.fetch()
    const botMessages = messages
      .filter(message => message.author.id === bot.user.id)
      .filter(message => !message.content.includes('❌'))
      .filter(message => !message.content.includes('ℹ️'))
    const botMessage = botMessages.first()
    const question = botMessage.content
    const index = steps.findIndex(step => step.question === question)
    const step = steps[index]
    return { step, index, botMessage}
  }

  const disableInput = async (channel, memberId) => {
    await channel.permissionOverwrites.set([
      {
        id: EVERYONE_ROLE_ID,
        deny: ['VIEW_CHANNEL']
      },
      {
        id: memberId,
        allow: ['VIEW_CHANNEL'],
        deny: ['SEND_MESSAGES']
      },
      {
        id: bot.user.id,
        allow: ['VIEW_CHANNEL', 'MANAGE_CHANNELS', 'ADD_REACTIONS']
      }
    ])
  }

  const enableInput = async (channel, memberId) => {
    await channel.permissionOverwrites.set([
      {
        id: EVERYONE_ROLE_ID,
        deny: ['VIEW_CHANNEL']
      },
      {
        id: memberId,
        allow: ['VIEW_CHANNEL']
      },
      {
        id: bot.user.id,
        allow: ['VIEW_CHANNEL', 'MANAGE_CHANNELS', 'ADD_REACTIONS']
      }
    ])
  }

  const sendNextStep = async (
    currentStepIndex,
    channel,
    member
  ) => {
    currentStepIndex += 1
    const nextStep = steps[currentStepIndex]

    if (nextStep) {
      const shouldSkip = await nextStep.shouldSkip?.(member)
      if (shouldSkip) {
        await sendNextStep(currentStepIndex, channel, member)
        return
      }

      let message 
      if (nextStep.attachment) {
        message = await channel.send({
          content: nextStep.question,
          files: [nextStep.attachment]
        })
      } else {
        message = await channel.send(nextStep.question)
      }

      if(nextStep.expectedReaction) {
        await disableInput(channel, member.id)
        await message.react(nextStep.expectedReaction)
      }

      if (nextStep.processImmediately) {
        await processAnswer(nextStep, currentStepIndex, channel, member, '')
      }
    } else {
      // no more steps? onboarding complete!
      await assignProMemberRole(member)
      await addTag(member)
      await assignRegularMemberRole(member)
      await cleanupChannel(channel)
      await sendWelcomeDirectMessage(member)
    }
  }

  const processAnswer = async (
    currentStep,
    currentStepIndex,
    channel,
    member,
    answer) => {
      const error = currentStep.validate?.(answer, member)
      if (error) {
        await channel.send(createError(error, channel))
        return
      }
      await currentStep.process?.(answer, member, channel)
      if (currentStep.successMessage) {
        await channel.send(currentStep.successMessage)
      }
      await sendNextStep(currentStepIndex, channel, member)
    }

  bot.on('message', async message => {
    const { 
      channel,
      author,
      content: answer,
      member
    } = message

    if (channel.type !== "GUILD_TEXT" || !channel.name.startsWith(WELCOME_PREFIX)) {
      return
    }

    const onboardee = extractOnboardeeIdFromChannelName(channel.name)
    const sender = author.id

    if (sender !== onboardee) {
      return
    }
    const { step, index } = await findCurrentStep(channel)
    if (answer.toLowerCase() === "help") {
      await channel.send(step.help)
      return
    }
    await processAnswer(step, index, channel, member, answer)
  })

  bot.on('messageReactionAdd', async (messageReaction, user) => {
    const { 
      message: { channel },
      emoji : { name: answer }
    } = messageReaction

    if (channel.type !== "GUILD_TEXT" || !channel.name.startsWith(WELCOME_PREFIX) ) {
      return
    }

    if (user.id === bot.user.id) {
      return
    }

    const onboardee = extractOnboardeeIdFromChannelName(channel.name)
    const reactor = user.id

    if (reactor === onboardee) {
      const { step, index } = await findCurrentStep(channel)

      if (step.expectedReaction && step.expectedReaction !== answer)  {
        return
      }

      await enableInput(channel, user.id)
      const member = await getOnboardeeFromChannel(channel)
      await processAnswer(step, index, channel, member, answer)
    }
  })

  const assignProMemberRole = async member =>  {
    try {
      const user = await findScrimbaUserByDiscordId(member.id)
      if (user) {
        if (user.active === true) {
          await member.roles.add(PRO_ROLE_ID)
        }
      }
    } catch (error) {
      console.error("error assignProMemberRole", error)
    }
  }

  const assignRegularMemberRole = async member =>  {
    try {
      await member.roles.add(REGULAR_MEMBER_ROLE_ID)
    } catch (error) {
      console.error("error assignRegularMemberRole", error)
      console.log("This normally happens because the bot is missing Manage Roles bot permission (granted when adding the bot with OAuth). Also happens if the bot's role is lower than REGULAR_MEMBER_ROLE_ID in roles list.")
    }
  }

  const sendWelcomeDirectMessage = member => member.send(`Welcome to the Scrimba Discord community 👋 

Joining a new Discord server can feel overwhelming, so we've gathered the most important information for you here.

**Step 1: Check out the most important channels**
In our community, you should first #👋introduce-yourself. Then, feel free to ask for #💼career-advice, and please #💻share-your-code if you have written something you're proud of. Finally, we also have a whole section dedicated to giving and getting coding help (more info below). You can also head over to one of our help channels if you're stuck, like #css-help, #javascript-help, or #react-help.

**Step 2: Remember to be nice**
We aim to be the friendliest space for developers to hang out. This means that there's no room for negativity, harsh criticism or bullying. If you misbehave, you will be given a warning and a 24 hour ban. If you misbehave once more, we'll need to ban you permanently.

We're excited to have you here! `) 

  const findScrimbaUserByDiscordId = async (discordId) => {
    try {
      // TODO should use Knex for consistency
      const { rows }  = await pool
        .query(`SELECT 
              u.id, 
              u.email,
              s.active
            FROM USERS AS u
            LEFT JOIN subscriptions AS s ON u.id = s.uid AND s.active = true
            WHERE u.discord_id = '${discordId}'`)
      const user = rows[0]
      return user
    } catch (error) {
      console.error("error findScrimbaUserByDiscordId", error)
      // process.exit(1)
    }
  }

  const fetchScrimbaUser = async (discordId, channel) => {
    await disableInput(channel, discordId)
    return new Promise(resolve => {
      const interval = setInterval(async () => {
        const user = await findScrimbaUserByDiscordId(discordId)
        if (user) {
          if (user.active === true) {
            // TODO use ./source/assets/pop_that_bottle.gif
            await channel.send("ℹ️ Oh! You are a PRO member. I will add a special badge to your profile! https://media.giphy.com/media/g9582DNuQppxC/giphy.gif",)
          }
          await enableInput(channel, discordId)
          resolve()
          clearInterval(interval)
        }
      }, 1000)
    })
  }

  const cleanupChannel = channel => channel.delete()

  const offerHelpOrKick = async channel => {
    // sometimes channel no longer exists when this func 
    // is run. Not sure why. TODO check if channel exists
    // before referencing it
    const { step, botMessage } = await findCurrentStep(channel)
    const now = new Date()
    const millisecondsSinceQuestion = now - botMessage.createdAt
    const messages = await channel
      .messages
      .fetch()
    const messagesSinceQuestion = messages.filter(message => message.createdAt > botMessage.createdAt)

    if (millisecondsSinceQuestion >= MILLISECONDS_BEFORE_KICKING) {
      const member = await getOnboardeeFromChannel(channel)
      await member.kick()
      return
    }

    if (millisecondsSinceQuestion >= MILLISECONDS_BEFORE_KICK_WARNING) {
      const error = createError(`you've been on this step for a few minutes.

Remember, you can always message <@425243762151915523> from Scrimba if you're having trouble!

If, in a few minutes, you're still on this step, I will softly remove you from the server and delete this channel.  Don't worry! You can always join again and attempt the onboarding.`, channel)
      if (!messagesSinceQuestion.some(message => message.content === error)) {
        await channel.send(error)
      }  
      return
    }

    if (step.help && millisecondsSinceQuestion >= MILLISECONDS_BEFORE_OFFERING_HELP) {
      const error = createError(step.help, channel)
      if (!messagesSinceQuestion.some(message => message.content === error)) {
        await channel.send(error)
      }  
    }
  }

  const createError = (text, channel) => {
    if (channel){
      const onboardeeId = extractOnboardeeIdFromChannelName(channel.name)
      return `❌ <@${onboardeeId}>, ${text}`
    }
    return `❌ ${text}`
  }

  const fetchSubscriber = async email => {
    const url = new URL('https://api.convertkit.com/v3/subscribers')
    url.searchParams.set('api_secret', CONVERT_KIT_API_SECRET)
    url.searchParams.set('email_address', email)

    const { body } = await got(url.toString(), {
      responseType: 'json'
    })

    return body.subscribers.shift()
  }

  const addTag = async member => {
    const { email } = await findScrimbaUserByDiscordId(member.id)
    const subscriber = await fetchSubscriber(email)
    if (subscriber) {
      const response = await got.post(
        `https://api.convertkit.com/v3/tags/${CONVERT_KIT_TAG_ID}/subscribe`,
        {
          responseType: 'json',
          json: {
            api_key: CONVERT_KIT_API_KEY,
            api_secret: CONVERT_KIT_API_SECRET,
            email: email
          },
        },
      )
    } else {
      await got.post(
        `https://api.convertkit.com/v3/forms/${CONVERT_KIT_FORM_ID}/subscribe`,
        {
          responseType: 'json',
          json: {
            api_key: CONVERT_KIT_API_KEY,
            api_secret: CONVERT_KIT_API_SECRET,
            email: email
          },
        },
      )
    }
  }
}
