const { MessageEmbed } = require('discord.js');

const karma = (bot, knex) => {
  const NOTIFICATIONS_CHANNEL_ID = '868130359106207844'

  bot.on('messageReactionAdd', async (messageReaction, user) => {
    if (messageReaction.partial) {
      await messageReaction.fetch()
    }
    const { message, emoji } = messageReaction
    const notificationsChannel = await bot
      .channels
      .fetch(NOTIFICATIONS_CHANNEL_ID)
    if (user.id !== message.author.id 
      && user.id !== bot.user.id 
      && emoji.name === '💜') {

      // const rows1 = await knex('reputations')
      //   .where({ from: user.id, messageId: message.id })
      // if (rows1.length > 0) {
      // await notificationsChannel.send(`<@${user.id}> reacted to <@${message.author.id}>'s message but no more points were given lol`)
      //   return
      // }

      await knex('reputations')
        .insert({
          points: 1,
          from: user.id,
          to: message.author.id,
          messageId: message.id
        })
      const rows = await knex('reputations')
        .where('to', message.author.id)
        .sum('points')
      const count = rows.shift().sum || 0 // should never be 0 since this code is only run in response to you getting some reputation in the first place lol
      console.log("count", count)
      const exampleEmbed = new MessageEmbed()
        .setColor('#0099ff')
        .setAuthor('Scrimba', bot.user.displayAvatarURL(), 'https://discord.js.org')
        .setDescription(`Well done <@${message.author.id}>! <@${user.id}> reacted to your post [post](https://example.com) in <#${message.channel.id}> with 💜 which earned you a point.

You now have ${count} karma!`)
      await notificationsChannel.send({embeds: [exampleEmbed]})
      // await notificationsChannel.send(`<@${user.id}> reacted to <@${message.author.id}>'s message in the <#${message.channel.id}> channel (https://discord.com/channels/684009642984341525/${message.channel.id}/${message.id}) with the ${emoji.name} emoji. <@${message.author.id}> earned +1 point and now has a total of ${count} points. `)
    }
  })
}

module.exports = karma
